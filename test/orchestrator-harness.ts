/*
 * What the orchestrator's tests share (test/orchestrator*.test.ts): a fake claude CLI swapped into
 * `runners`, steered by `fake`, and a new database, store, orchestrator and project folder before each
 * test. Vitest runs test files side by side, but the tests of one file one after another, so they are
 * split by topic into several files. Each file gets a copy of this module of its own (Vitest isolates
 * test files), with a temporary folder and a data folder of its own.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { AgentConfig, Conversation, ConversationSettings } from '../src/shared/types';
import { slow } from './timeouts';

// Each test runs git several times (a snapshot before and after each turn, worktrees), and the files
// that share this module run side by side: 20 s rather than Vitest's 5 s, for a busy machine.
vi.setConfig({ testTimeout: slow(20_000) });

/** When `gate` is set, copying a branch's attached files waits for it. */
export const copying: { gate: Promise<void> | undefined } = { gate: undefined };
// Hoisted above `copying`, but the module is first loaded below (`await import`), after it.
vi.mock('../src/server/attachments', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/attachments')>();
  return {
    ...real,
    copyAttachments: async (...args: Parameters<typeof real.copyAttachments>) => {
      if (copying.gate) await copying.gate;
      return real.copyAttachments(...args);
    },
  };
});

// Worktrees live under RELAY_DATA_DIR, which is read when the server modules load.
export const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-orch-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

export const { openDatabase } = await import('../src/server/db');
export const { Hub } = await import('../src/server/hub');
export const { Orchestrator, branchAfterCut, branchOrigin, branchPause } = await import('../src/server/orchestrator');
export const { SettingsStore } = await import('../src/server/settings');
export const { Store } = await import('../src/server/store');
export const { AgentRunError, runners, stateKeys } = await import('../src/server/agents');
export const { removeTree } = await import('../src/server/fsRemove');
export const { stateFolder } = await import('../src/server/agents/open');
export const { PLANNER_BRIEFING, REVISER_BRIEFING } = await import('../src/server/planner');
export const { GROUPER_BRIEFING } = await import('../src/server/grouping');
export const { REVIEWER_BRIEFING } = await import('../src/server/reviewer');
export const { withLang } = await import('../src/server/i18n');
export const { attachmentPath, attachmentsDir, safeFileName } = await import('../src/server/attachments');
export const { mediaRoots, resolveMedia } = await import('../src/server/media');
export const { worktreeDir } = await import('../src/server/workspace');
export const { BUSY_RETRY_MS, MISSED_AFTER_MS, Scheduler, scheduleTime } = await import('../src/server/scheduler');

/** A fake CLI run. */
export interface Call {
  name: string;
  sessionId?: string;
  prompt: string;
  cwd?: string;
  /** The other working directories it was given. */
  addDirs?: string[];
  systemPrompt?: string;
  images?: { path: string; mimeType: string }[];
  attachmentsDir?: string;
  nativeOff?: readonly string[];
  nativeItems?: Record<string, string[]>;
  sandboxTerminal?: boolean;
  stateKey?: string;
  freshState?: boolean;
  permission?: string;
  /** The CLI's home it was started with (its account's). */
  home?: string;
  model?: string;
  effort?: string;
}

/** Every fake CLI run, in order (emptied before each test; a test empties it with `calls.length = 0`). */
export const calls: Call[] = [];

// Made again before each test. A test that needs an orchestrator or a store of its own sets it with
// `setOrchestrator` or `setStore`.
export let n = 0;
export let orchestrator: InstanceType<typeof Orchestrator>;
export let store: InstanceType<typeof Store>;
export let db: ReturnType<typeof openDatabase>;
export let project: string;
export let settings: InstanceType<typeof SettingsStore>;

export function setOrchestrator(o: InstanceType<typeof Orchestrator>): void {
  orchestrator = o;
}

export function setStore(s: InstanceType<typeof Store>): void {
  store = s;
}

/** How the fake CLIs behave. Each test sets what it needs; all of it is reset before each test. */
export interface Fake {
  /** Resolves when the fake agent may finish its turn. */
  gate: Promise<void>;
  /** Per-agent gates: when set, that agent waits for its own gate instead of `gate`. */
  gates: Record<string, Promise<void>>;
  /** What the fake lead agent replies when asked to design a team (auto team). */
  leadReply: string;
  /** When set, the fake lead agent waits for it before replying. */
  leadGate: Promise<void> | undefined;
  /** What the fake lead agent replies when asked to change a team (team drawer). */
  reviseReply: string;
  /** When set, the fake lead agent waits for it before changing the team (or until it is stopped). */
  reviseGate: Promise<void> | undefined;
  /** When set, the next fake lead agent run, once stopped, ends only when it resolves (a CLI slow to exit). */
  reviseLinger: Promise<void> | undefined;
  /** When set, the fake lead agent's CLI fails with this message when asked to change a team. */
  reviseFail: string | undefined;
  /** What the fake lead agent replies when asked to sort a conversation into a sidebar group. */
  sorterReply: string;
  /** When set, the fake lead agent waits for it before sorting (or until it is stopped). */
  sorterGate: Promise<void> | undefined;
  /** What the fake lead agent replies when asked to review the team's replies (lead review). */
  reviewReply: string;
  /** When set, the fake lead agent waits for it before reviewing (or until it is stopped). */
  reviewGate: Promise<void> | undefined;
  /** When set, the fake lead agent's CLI fails with this message when asked to review. */
  reviewFail: string | undefined;
  /** Runs inside an agent's fake CLI turn after it wrote its files (e.g. to commit them itself). */
  during: ((name: string, cwd: string) => void) | undefined;
  /** Agents that ask the user a question until their prompt carries an answer ("ANSWER:"). */
  asking: Set<string>;
  /** Makes an agent's fake CLI run fail (after it wrote its files), e.g. to simulate a rate limit. */
  fail: ((name: string, sessionId?: string) => Error | undefined) | undefined;
  /** The way to ask the user that a fake CLI run whose prompt says "keep asking" had (kept past its turn). */
  keptAsk: ((req: { kind: 'fetch'; detail: string }) => Promise<unknown>) | undefined;
}

const fresh = (): Fake => ({
  gate: Promise.resolve(),
  gates: {},
  leadReply: '',
  leadGate: undefined,
  reviseReply: '',
  reviseGate: undefined,
  reviseLinger: undefined,
  reviseFail: undefined,
  sorterReply: '{"group": 0}',
  sorterGate: undefined,
  reviewReply: '{"summary": "All good.", "highlights": [], "nextSteps": []}',
  reviewGate: undefined,
  reviewFail: undefined,
  during: undefined,
  asking: new Set(),
  fail: undefined,
  keptAsk: undefined,
});

export const fake: Fake = fresh();

// A fake CLI: writes `<name>.txt` and `shared.txt` in its cwd, then replies.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      if (o.systemPrompt === GROUPER_BRIEFING) {
        calls.push({ name: 'sorter', prompt: o.prompt, nativeOff: o.nativeOff, nativeItems: o.nativeItems, sandboxTerminal: o.sandboxTerminal, stateKey: o.stateKey, model: o.model, effort: o.effort });
        if (fake.sorterGate && !o.signal?.aborted) {
          await Promise.race([fake.sorterGate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
        }
        if (o.signal?.aborted) throw new AgentRunError('stopped', true);
        o.onEvent({ type: 'text', text: fake.sorterReply });
        o.onEvent({ type: 'text_end' });
        return { sessionId: 'sorter-session' };
      }
      if (o.systemPrompt === REVIEWER_BRIEFING) {
        calls.push({ name: 'reviewer', prompt: o.prompt, cwd: o.cwd, stateKey: o.stateKey, permission: o.permission, model: o.model, effort: o.effort });
        if (fake.reviewGate && !o.signal?.aborted) {
          await Promise.race([fake.reviewGate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
        }
        if (o.signal?.aborted) throw new AgentRunError('stopped', true);
        if (fake.reviewFail) throw new Error(fake.reviewFail);
        o.onEvent({ type: 'text', text: fake.reviewReply });
        o.onEvent({ type: 'text_end' });
        return { costUsd: 0.03, sessionId: 'reviewer-session' };
      }
      if (o.systemPrompt === REVISER_BRIEFING) {
        calls.push({ name: 'reviser', prompt: o.prompt, cwd: o.cwd, stateKey: o.stateKey, model: o.model, effort: o.effort, nativeOff: o.nativeOff, home: o.env?.CLAUDE_CONFIG_DIR });
        // Only the run that starts while it is set lingers.
        const linger = fake.reviseLinger;
        fake.reviseLinger = undefined;
        if (fake.reviseGate && !o.signal?.aborted) {
          await Promise.race([fake.reviseGate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
        }
        // Like a CLI that takes a while to end once it is stopped.
        if (o.signal?.aborted && linger) await linger;
        if (o.signal?.aborted) throw new AgentRunError('stopped', true);
        if (fake.reviseFail) throw new Error(fake.reviseFail);
        o.onEvent({ type: 'text', text: fake.reviseReply });
        o.onEvent({ type: 'text_end' });
        return { costUsd: 0.02, sessionId: 'reviser-session' };
      }
      if (o.systemPrompt === PLANNER_BRIEFING) {
        calls.push({
          name: 'lead',
          sessionId: o.sessionId,
          prompt: o.prompt,
          nativeOff: o.nativeOff,
          nativeItems: o.nativeItems,
          sandboxTerminal: o.sandboxTerminal,
          stateKey: o.stateKey,
          home: o.env?.CLAUDE_CONFIG_DIR,
          model: o.model,
          effort: o.effort,
        });
        if (fake.leadGate) await fake.leadGate;
        o.onEvent({ type: 'text', text: fake.leadReply });
        o.onEvent({ type: 'text_end' });
        return { costUsd: 0.01, sessionId: 'lead-session' };
      }
      const name = /You are @(\w+)/.exec(o.systemPrompt)![1]!;
      calls.push({
        name,
        sessionId: o.sessionId,
        prompt: o.prompt,
        cwd: o.cwd,
        ...(o.addDirs ? { addDirs: o.addDirs } : {}),
        systemPrompt: o.systemPrompt,
        images: o.images,
        attachmentsDir: o.attachmentsDir,
        nativeOff: o.nativeOff,
        nativeItems: o.nativeItems,
        sandboxTerminal: o.sandboxTerminal,
        stateKey: o.stateKey,
        freshState: o.freshState,
        permission: o.permission,
        home: o.env?.CLAUDE_CONFIG_DIR,
        model: o.model,
        effort: o.effort,
      });
      writeFileSync(join(o.cwd, 'shared.txt'), `written by ${name}\n`);
      writeFileSync(join(o.cwd, `${name}.txt`), `${name}\n`);
      // In each other working directory too.
      for (const dir of o.addDirs ?? []) writeFileSync(join(dir, `${name}.txt`), `${name} was here\n`);
      fake.during?.(name, o.cwd);
      // Like a real CLI, a run ends when it is stopped.
      if (!o.signal?.aborted) {
        await Promise.race([fake.gates[name] ?? fake.gate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
      }
      if (o.signal?.aborted) throw new AgentRunError('stopped', true);
      const failure = fake.fail?.(name, o.sessionId);
      if (failure) throw failure;
      if (o.prompt.includes('keep asking')) fake.keptAsk = o.requestApproval;
      if (o.prompt.includes('crash after asking')) {
        // The CLI asks, then dies before the user answers.
        void o.requestApproval?.({ kind: 'command', detail: 'npm install left-pad' });
        throw new Error('CLI crashed');
      }
      if (o.prompt.includes('please install')) {
        // Something the permission does not cover: ask (when the conversation asks).
        const answer = o.requestApproval
          ? await o.requestApproval({ kind: 'command', detail: 'npm install left-pad', reason: 'Install a dependency' })
          : undefined;
        const outcome = !answer ? 'not asked' : answer.allow ? 'installed' : `skipped (${answer.note ?? 'no note'})`;
        o.onEvent({ type: 'text', text: `${name} ${outcome}` });
        o.onEvent({ type: 'text_end' });
        return { sessionId: `session-${name}` };
      }
      if (o.prompt.includes('search the web')) {
        // Like a server-side web search: what it searched for only comes with the result.
        o.onEvent({ type: 'tool_start', id: `ws-${name}`, name: 'Web search' });
        o.onEvent({ type: 'tool_end', id: `ws-${name}`, ok: true, detail: `${name}'s query` });
        // Most calls say what they are about from the start.
        o.onEvent({ type: 'tool_start', id: `sh-${name}`, name: 'Shell', detail: 'npm test', kind: 'execute' });
        o.onEvent({ type: 'tool_end', id: `sh-${name}`, ok: true, output: 'ok' });
      }
      if (fake.asking.has(name) && !o.prompt.includes('ANSWER:')) {
        o.onEvent({ type: 'text', text: `${name} asks: A or B?\n\n[ASK_USER]` });
        o.onEvent({ type: 'text_end' });
        return { sessionId: `session-${name}` };
      }
      o.onEvent({ type: 'text', text: `${name} done` });
      o.onEvent({ type: 'text_end' });
      return { sessionId: `session-${name}` };
    },
  };
});

// As the server does at its next start: a folder a run locked (`chmod 000`) stays set aside until then, and
// rmSync cannot remove it as it is (Node 24's, not even an empty one).
afterAll(() => {
  removeTree(root, { restore: true });
  expect(existsSync(root)).toBe(false);
});

beforeEach(() => {
  calls.length = 0;
  db = openDatabase(':memory:');
  store = new Store(db);
  // Only the fake claude CLI exists here, so the lead agent may only staff claude members.
  settings = new SettingsStore(db);
  orchestrator = new Orchestrator(store, new Hub(), settings, {
    context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }),
  });
  Object.assign(fake, fresh());
  project = join(root, `project-${++n}`);
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'shared.txt'), 'original\n');
});

export const agents: AgentConfig[] = [
  { id: 'a', name: 'Alice', provider: 'claude', role: '' },
  { id: 'b', name: 'Bob', provider: 'claude', role: '' },
];

export function conversation(settings: Partial<ConversationSettings>): Conversation {
  const conv: Conversation = {
    id: `conv-${n}-${Math.random().toString(36).slice(2)}`,
    title: 'test',
    createdAt: 0,
    updatedAt: 0,
    agents,
    settings: { mode: 'parallel', rounds: 1, maxHops: 5, permission: 'edit', cwd: project, ...settings },
    messages: [],
    agentState: {},
    worktrees: {},
  };
  store.create(conv);
  return conv;
}

export async function finish(convId: string): Promise<void> {
  await vi.waitFor(() => expect(orchestrator.isRunning(convId)).toBe(false), { timeout: 20_000, interval: 50 });
}

export const agentMessages = (conv: Conversation) => conv.messages.filter((m) => m.author.kind === 'agent');
export const textOf = (m: Conversation['messages'][number]) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
export const firstUserMessage = (conv: Conversation) => conv.messages.find((m) => m.author.kind === 'user')!;
