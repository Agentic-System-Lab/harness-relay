import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentConfig,
  AgentSessionState,
  AgentWorktree,
  ChatMessage,
  Conversation,
  FileChange,
  MessageChanges,
  MessagePart,
} from '../shared/types';
import { AgentRunError, runners, type AgentEvent, type RunResult } from './agents';
import { HttpError } from './errors';
import type { Hub } from './hub';
import { buildBriefing, buildTurnPrompt, isPass, parseMentions, type BriefingWorkspace, type TurnInfo } from './prompt';
import { DATA_DIR, type SettingsStore } from './settings';
import type { Store } from './store';
import {
  applyToWorkingTree,
  commitWorktree,
  createWorktree,
  diffFiles,
  diffText,
  ensureRepo,
  removeWorktree,
  snapshot,
  worktreeCwd,
  worktreeHead,
} from './workspace';

export { HttpError };

/** Where agents of one run write. */
interface RunWorkspace {
  /** Repository root of the working directory; set when agents may write (edit / full). */
  root?: string;
  /** Parallel mode with write access: every agent works in its own git worktree. */
  isolated: boolean;
}

interface Run {
  abort: AbortController;
  active: Set<string>;
  ws: RunWorkspace;
}

export const DEFAULT_TITLE = '新對話';

function textOf(m: ChatMessage): string {
  return m.parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}

/**
 * Drives a conversation: decides which agent speaks next, builds each agent's prompt from the
 * messages it hasn't seen yet, runs the CLI, and streams the result to connected browsers.
 */
export class Orchestrator {
  private runs = new Map<string, Run>();
  /** Repository root → conversation currently writing to its working tree. */
  private dirLocks = new Map<string, string>();

  constructor(
    private store: Store,
    private hub: Hub,
    private settings: SettingsStore,
  ) {}

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  activeAgentIds(id: string): string[] {
    return [...(this.runs.get(id)?.active ?? [])];
  }

  /** Post a user message (or, with empty text, let the team continue) and start the team's turn. */
  async send(convId: string, rawText: string): Promise<void> {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, '找不到對話');
    if (this.runs.has(convId)) throw new HttpError(409, '團隊還在回覆中，請先等待或按停止');
    if (conv.agents.length === 0) throw new HttpError(400, '這個對話沒有任何 agent');
    const text = rawText.trim();
    if (!text && !conv.messages.some((m) => m.author.kind === 'user')) throw new HttpError(400, '請先輸入訊息');

    const ws = await this.prepareWorkspace(conv);
    // Re-check after the await: another request may have started a run meanwhile.
    if (this.runs.has(convId)) throw new HttpError(409, '團隊還在回覆中，請先等待或按停止');
    const lockRoot = ws.root && !ws.isolated ? ws.root : undefined;
    if (lockRoot) this.lockDir(lockRoot, conv);

    if (text) {
      const msg: ChatMessage = {
        id: randomUUID(),
        author: { kind: 'user' },
        createdAt: Date.now(),
        parts: [{ type: 'text', text }],
        status: 'done',
      };
      conv.messages.push(msg);
      this.store.saveMessage(conv.id, msg, true);
      this.hub.emit(conv.id, { type: 'message', message: msg });
      if (conv.title === DEFAULT_TITLE) {
        const line = text.split('\n')[0]!.trim();
        conv.title = line.length > 40 ? line.slice(0, 39) + '…' : line;
        this.emitConversation(conv);
      }
    }
    conv.updatedAt = Date.now();
    this.store.saveMeta(conv);

    const run: Run = { abort: new AbortController(), active: new Set(), ws };
    this.runs.set(convId, run);
    this.emitStatus(conv.id);

    this.execute(conv, text, run)
      .catch((err) => {
        console.error('[orchestrator] run failed:', err);
        this.systemNote(conv, `執行失敗：${(err as Error).message}`);
      })
      .finally(() => {
        if (run.abort.signal.aborted) this.systemNote(conv, '已停止。');
        if (lockRoot) this.unlockDir(lockRoot, conv.id);
        this.runs.delete(convId);
        conv.updatedAt = Date.now();
        this.store.flush(conv.id);
        this.store.saveMeta(conv);
        this.emitStatus(conv.id);
      });
  }

  stop(convId: string): void {
    this.runs.get(convId)?.abort.abort();
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.abort.abort();
  }

  emitConversation(conv: Conversation): void {
    this.hub.emit(conv.id, {
      type: 'conversation',
      title: conv.title,
      agents: conv.agents,
      settings: conv.settings,
      worktrees: conv.worktrees,
    });
  }

  // Workspace ---------------------------------------------------------------

  /** Agents that may write need a git repository (created automatically) to track and isolate changes. */
  async prepareWorkspace(conv: Conversation): Promise<RunWorkspace> {
    if (conv.settings.permission === 'read-only') return { isolated: false };
    const { root, created } = await ensureRepo(conv.settings.cwd);
    if (created) this.systemNote(conv, `工作目錄原本不是 git repository，已自動執行 git init：${root}`);
    return { root, isolated: conv.settings.mode === 'parallel' };
  }

  private lockDir(root: string, conv: Conversation): void {
    const holder = this.dirLocks.get(root);
    if (holder && holder !== conv.id) {
      const title = this.store.get(holder)?.title ?? holder;
      throw new HttpError(409, `對話「${title}」正在修改 ${root}，請等它結束後再試（或改用唯讀 / 平行模式）。`);
    }
    this.dirLocks.set(root, conv.id);
  }

  private unlockDir(root: string, convId: string): void {
    if (this.dirLocks.get(root) === convId) this.dirLocks.delete(root);
  }

  /** Give every participant its own worktree, starting from a snapshot of the working directory. */
  private async prepareWorktrees(conv: Conversation, agents: AgentConfig[], root: string): Promise<void> {
    let base: string | undefined;
    for (const a of agents) {
      const cur = conv.worktrees[a.id];
      if (cur && cur.root === root && !cur.needsReset && existsSync(cur.path)) continue;
      if (cur && cur.root !== root) await removeWorktree(cur.root, cur.path, cur.branch).catch(() => {});
      base ??= (await snapshot(root)).commit;
      const reuse = cur && cur.root === root;
      const wt: AgentWorktree = {
        root,
        path: reuse ? cur.path : join(DATA_DIR, 'worktrees', conv.id, a.id),
        branch: reuse ? cur.branch : `relay/${conv.id.slice(0, 8)}/${a.name}`,
        base,
        needsReset: false,
      };
      await createWorktree(root, wt.path, wt.branch, base);
      conv.worktrees[a.id] = wt;
      this.store.saveWorktree(conv.id, a.id, wt);
    }
    this.emitConversation(conv);
  }

  /** Apply everything an agent did in its worktree to the real working directory (uncommitted). */
  async applyAgentWork(convId: string, agentId: string): Promise<FileChange[]> {
    const conv = this.store.get(convId);
    if (!conv) throw new HttpError(404, '找不到對話');
    const wt = conv.worktrees[agentId];
    if (!wt) throw new HttpError(404, '這位成員沒有 worktree');
    if (wt.needsReset) throw new HttpError(409, '工作目錄已經更新過，這份結果已過期；請讓團隊再跑一輪。');
    if (this.runs.has(convId)) throw new HttpError(409, '團隊還在回覆中，請等回覆結束再套用');
    this.lockDir(wt.root, conv);
    try {
      const files = await applyToWorkingTree(wt.root, wt.base, await worktreeHead(wt.path));
      for (const [id, w] of Object.entries(conv.worktrees)) {
        w.needsReset = true;
        this.store.saveWorktree(conv.id, id, w);
      }
      const name = conv.agents.find((a) => a.id === agentId)?.name ?? agentId;
      this.systemNote(
        conv,
        `已把 @${name} 的修改套用到工作目錄（${files.length} 個檔案，尚未 commit）。下一次平行作業會從新的工作目錄狀態開始。`,
      );
      this.emitConversation(conv);
      return files;
    } finally {
      this.unlockDir(wt.root, conv.id);
    }
  }

  async messageDiff(convId: string, messageId: string): Promise<string> {
    const msg = this.store.get(convId)?.messages.find((m) => m.id === messageId);
    if (!msg?.changes) throw new HttpError(404, '這則訊息沒有檔案修改');
    return diffText(msg.changes.root, msg.changes.base, msg.changes.head);
  }

  async agentDiff(convId: string, agentId: string): Promise<string> {
    const wt = this.store.get(convId)?.worktrees[agentId];
    if (!wt) throw new HttpError(404, '這位成員沒有 worktree');
    return diffText(wt.root, wt.base, await worktreeHead(wt.path));
  }

  /** Remove a conversation's worktrees and branches (before deleting it). */
  async cleanupWorktrees(conv: Conversation): Promise<void> {
    for (const wt of Object.values(conv.worktrees)) {
      await removeWorktree(wt.root, wt.path, wt.branch).catch((err) =>
        console.warn('[orchestrator] worktree cleanup failed:', (err as Error).message),
      );
    }
    rmSync(join(DATA_DIR, 'worktrees', conv.id), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------

  private async execute(conv: Conversation, text: string, run: Run): Promise<void> {
    const { mode, rounds, maxHops } = conv.settings;
    const mentioned = text ? parseMentions(text, conv.agents) : [];
    const participants = mentioned.length ? mentioned : conv.agents;
    const aborted = () => run.abort.signal.aborted;
    const spoke = (m: ChatMessage) => m.status === 'done' && !m.passed;

    if (mode === 'relay') {
      const queue: { agent: AgentConfig; handedBy?: string }[] = (mentioned.length ? mentioned : [conv.agents[0]!]).map(
        (agent) => ({ agent }),
      );
      let hops = 0;
      while (queue.length && !aborted()) {
        if (hops >= maxHops) {
          this.systemNote(conv, `已達接力上限（${maxHops} 棒），交還給使用者。可按「繼續」讓團隊接著做。`);
          break;
        }
        const { agent, handedBy } = queue.shift()!;
        hops++;
        const msg = await this.turn(conv, agent, run, { mode, round: 1, rounds: 1, handedBy, hopsLeft: maxHops - hops });
        if (!spoke(msg)) continue;
        for (const next of parseMentions(textOf(msg), conv.agents, agent.id)) {
          if (!queue.some((q) => q.agent.id === next.id)) queue.push({ agent: next, handedBy: agent.name });
        }
      }
      return;
    }

    if (mode === 'parallel' && run.ws.isolated) await this.prepareWorktrees(conv, participants, run.ws.root!);

    for (let round = 1; round <= rounds && !aborted(); round++) {
      const info: TurnInfo = { mode, round, rounds };
      let msgs: ChatMessage[];
      if (mode === 'parallel') {
        msgs = await Promise.all(participants.map((a) => this.turn(conv, a, run, info)));
      } else {
        msgs = [];
        for (const a of participants) {
          if (aborted()) break;
          msgs.push(await this.turn(conv, a, run, info));
        }
      }
      if (!msgs.some(spoke)) break; // everyone passed: the discussion has converged
    }
  }

  /** One agent turn: build its prompt, run the CLI, stream into a new chat message. */
  private async turn(conv: Conversation, agent: AgentConfig, run: Run, info: TurnInfo): Promise<ChatMessage> {
    const state: AgentSessionState = (conv.agentState[agent.id] ??= { seen: [] });
    if (state.provider && state.provider !== agent.provider) {
      state.sessionId = undefined;
      state.seen = [];
    }
    state.provider = agent.provider;

    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'agent', agentId: agent.id },
      agentName: agent.name,
      provider: agent.provider,
      createdAt: Date.now(),
      parts: [],
      status: 'streaming',
      meta: info.mode === 'relay' ? {} : { round: info.round },
    };
    conv.messages.push(msg);
    this.store.saveMessage(conv.id, msg, true);
    run.active.add(agent.id);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.emitStatus(conv.id);

    // Where this agent works, and the state before its turn (to record what it changed).
    const wt = run.ws.isolated ? conv.worktrees[agent.id] : undefined;
    const cwd = wt ? worktreeCwd(wt.root, conv.settings.cwd, wt.path) : conv.settings.cwd;
    const workspace: BriefingWorkspace = wt
      ? {
          kind: 'isolated',
          cwd,
          branch: wt.branch,
          base: wt.base,
          teammates: conv.agents
            .filter((a) => a.id !== agent.id && conv.worktrees[a.id] && !conv.worktrees[a.id]!.needsReset)
            .map((a) => ({ name: a.name, branch: conv.worktrees[a.id]!.branch })),
        }
      : { kind: 'shared' };
    let before: { commit: string; tree?: string } | undefined;
    try {
      if (wt) before = { commit: await worktreeHead(wt.path) };
      else if (run.ws.root) before = await snapshot(run.ws.root);
    } catch (err) {
      console.warn('[orchestrator] could not snapshot before turn:', (err as Error).message);
    }

    let textOpen = false;
    const onEvent = (e: AgentEvent) => {
      switch (e.type) {
        case 'session':
          if (state.sessionId !== e.sessionId) {
            state.sessionId = e.sessionId;
            this.store.saveAgentState(conv.id, agent.id, state); // keep it even if the server dies mid-turn
          }
          return;
        case 'text': {
          const last = msg.parts[msg.parts.length - 1];
          if (textOpen && last?.type === 'text') last.text += e.text;
          else msg.parts.push({ type: 'text', text: e.text });
          textOpen = true;
          this.hub.emit(conv.id, { type: 'delta', messageId: msg.id, partIndex: msg.parts.length - 1, text: e.text });
          break;
        }
        case 'text_end':
          textOpen = false;
          return;
        case 'tool_start':
          textOpen = false;
          msg.parts.push({ type: 'tool', id: e.id, name: e.name, detail: e.detail, status: 'running' });
          this.hub.emit(conv.id, { type: 'message', message: msg });
          break;
        case 'tool_end': {
          const part = msg.parts.find((p) => p.type === 'tool' && p.id === e.id);
          if (part?.type === 'tool') {
            part.status = e.ok ? 'done' : 'error';
            this.hub.emit(conv.id, { type: 'message', message: msg });
          }
          break;
        }
      }
      this.store.saveMessage(conv.id, msg);
    };

    const attempt = async (fresh: boolean): Promise<RunResult> => {
      if (fresh) {
        state.sessionId = undefined;
        state.seen = [];
        msg.parts = [];
        textOpen = false;
        this.hub.emit(conv.id, { type: 'message', message: msg });
      }
      const seen = new Set(state.seen);
      // Everything this agent hasn't been shown yet, including its own earlier replies when starting fresh.
      // Messages still streaming (parallel peers) stay unseen and are delivered next turn.
      const delta = conv.messages.filter(
        (m) => m.id !== msg.id && m.author.kind !== 'system' && m.status === 'done' && !seen.has(m.id),
      );
      const prompt = buildTurnPrompt(conv, agent, delta, !state.sessionId, info);
      const seenBefore = state.seen;
      state.seen = [...state.seen, ...delta.map((m) => m.id)];
      try {
        const result = await runners[agent.provider].run({
          bin: this.settings.bin(agent.provider),
          env: this.settings.env(agent.provider),
          prompt,
          systemPrompt: buildBriefing(conv, agent, workspace),
          sessionId: state.sessionId,
          cwd,
          permission: conv.settings.permission,
          model: agent.model?.trim() || this.settings.defaultModel(agent.provider) || undefined,
          effort: agent.effort?.trim() || this.settings.defaultEffort(agent.provider) || undefined,
          signal: run.abort.signal,
          onEvent,
        });
        if (result.sessionId) state.sessionId = result.sessionId;
        return result;
      } catch (err) {
        state.seen = seenBefore; // not delivered; offer it again next turn
        throw err;
      }
    };

    const started = Date.now();
    try {
      const hadSession = Boolean(state.sessionId);
      let result: RunResult;
      try {
        result = await attempt(false);
      } catch (err) {
        // A stale or missing CLI session (e.g. the working directory changed): start over with full history.
        const aborted = err instanceof AgentRunError && err.aborted;
        if (!hadSession || aborted || msg.parts.length > 0) throw err;
        console.warn(`[orchestrator] resume failed for @${agent.name}, retrying fresh:`, (err as Error).message);
        result = await attempt(true);
      }
      const text = textOf(msg);
      msg.passed = isPass(text) || (!text && !msg.parts.some((p) => p.type === 'tool'));
      msg.status = 'done';
      msg.meta = {
        ...msg.meta,
        durationMs: Date.now() - started,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
      state.seen.push(msg.id);
    } catch (err) {
      const aborted = err instanceof AgentRunError && err.aborted;
      msg.status = aborted ? 'aborted' : 'error';
      msg.error = aborted ? undefined : (err as Error).message;
      msg.meta = { ...msg.meta, durationMs: Date.now() - started };
      for (const p of msg.parts) if (p.type === 'tool' && p.status === 'running') p.status = 'error';
    } finally {
      // Record file changes even when the turn failed or was stopped: the files changed anyway.
      if (before) {
        try {
          msg.changes = await this.captureChanges(run.ws.root!, before, wt, agent);
        } catch (err) {
          console.warn('[orchestrator] could not record changes:', (err as Error).message);
        }
      }
      run.active.delete(agent.id);
      conv.updatedAt = Date.now();
      this.hub.emit(conv.id, { type: 'message', message: msg });
      this.emitStatus(conv.id);
      this.store.saveMessage(conv.id, msg, true);
      this.store.saveAgentState(conv.id, agent.id, state);
      this.store.saveMeta(conv);
    }
    return msg;
  }

  private async captureChanges(
    root: string,
    before: { commit: string; tree?: string },
    wt: AgentWorktree | undefined,
    agent: AgentConfig,
  ): Promise<MessageChanges | undefined> {
    if (wt) {
      const head = await commitWorktree(wt.path, `@${agent.name} (Harness Relay)`);
      if (!head) return undefined;
      const files = await diffFiles(wt.root, before.commit, head);
      return { root: wt.root, base: before.commit, head, files, isolated: true, branch: wt.branch };
    }
    const after = await snapshot(root);
    if (after.tree === before.tree) return undefined;
    const files = await diffFiles(root, before.commit, after.commit);
    return { root, base: before.commit, head: after.commit, files, isolated: false };
  }

  systemNote(conv: Conversation, text: string): void {
    const msg: ChatMessage = {
      id: randomUUID(),
      author: { kind: 'system' },
      createdAt: Date.now(),
      parts: [{ type: 'text', text }],
      status: 'done',
    };
    conv.messages.push(msg);
    this.hub.emit(conv.id, { type: 'message', message: msg });
    this.store.saveMessage(conv.id, msg, true);
  }

  private emitStatus(id: string): void {
    this.hub.emit(id, { type: 'status', running: this.isRunning(id), activeAgentIds: this.activeAgentIds(id) });
  }
}
