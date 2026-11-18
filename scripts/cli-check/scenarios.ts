/**
 * Layer 3 of `scripts/cli-check.ts`: the recording scenarios of docs/adding-a-coding-agent.md (step
 * 6), each a turn through the adapter's own runner (`runners` in `src/server/agents/index.ts`) against
 * the real CLI, on the scripted model (`model.ts`), with every process it starts recorded. Each has its
 * checks, which say whether what Harness Relay relies on still holds, and its recording's shape, which
 * says what the CLI now says differently (`test/fixtures/cli-check/<cli>/run.json`).
 *
 * The CLI is put on the scripted model the way Harness Relay puts it on a model of the user's own:
 * Claude Code, Codex, Copilot and the open agents on an endpoint (Settings → Model backends);
 * Antigravity on the Gemini API's address with a key of its own (`GOOGLE_GEMINI_BASE_URL`), and Muse
 * Code on the Meta API's (`endpoint_transport` in its settings), which only a stand-in like this one
 * serves. Cursor runs only on its own service, and Grok needs its own sign-in even on an endpoint:
 * neither has this layer.
 *
 * Imported only once `isolate()` made the scratch environment this process's own.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOOK_PROVIDERS,
  isOpenProvider,
  type ApprovalAnswer,
  type CheckHook,
  type Permission,
  type Provider,
} from '../../src/shared/types';
import type { AgentEvent, ApprovalRequest, RunOptions, RunResult } from '../../src/server/agents/types';
import type { ToolGateway } from '../../src/server/gateway';
import { turnHooks } from '../../src/server/hooks';
import { loadShapes } from './layers';
import type { LayerOptions } from './layers';
import { MODEL, MUSE_MODEL, marker, startModel, type ScriptedModel, type Scenarios } from './model';
import { HELP_ARGS } from './probe';
import type { CliScratch, Scratch } from './scratch';
import { flagsIn, flagsOf, memoryRecorder, shapeOf, type Shape, type Spawned } from './shape';

/** The scenarios of what a CLI may not do below full access: they say nothing of a CLI that runs only with full access. */
export const BELOW_FULL = ['read-only-write', 'outside-write', 'protected-read', 'guard-write', 'guard-tool-write', 'hook-before'];

/** Why a CLI has no layer 3. */
export const NO_RUN: Partial<Record<Provider, string>> = {
  cursor: 'Cursor runs only on its own service: it takes no model address.',
  grok: 'Grok needs its own sign-in to start, even on an endpoint of the user’s own.',
};

const ENDPOINT_ID = 'check';

interface Placement {
  model?: string;
  env?: Record<string, string>;
  backends?: RunOptions['backends'];
}

/** How a CLI is put on the scripted model at `url`. */
function placement(p: Provider, url: string, scratch: Scratch): Placement {
  if (p === 'antigravity') return { env: { GEMINI_API_KEY: 'cli-check-key', GOOGLE_GEMINI_BASE_URL: url } };
  if (p === 'muse') {
    const dir = join(scratch.env.XDG_CONFIG_HOME!, 'muse');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ endpoint_transport: { base_url: `${url}/v1` } }, null, 2));
    return { model: MUSE_MODEL, env: { META_API_KEY: 'cli-check-key' } };
  }
  return {
    model: `${ENDPOINT_ID}/${MODEL}`,
    backends: {
      apis: {},
      endpoints: [{ id: ENDPOINT_ID, name: 'cli-check', baseUrl: `${url}/v1`, models: [MODEL], apiKey: 'cli-check-key' }],
    },
  };
}

export interface Check {
  ok: boolean | 'warn';
  what: string;
}

interface Scenario {
  name: string;
  permission: Permission;
  /** The shell command the model asks to run, `{nonce}` and the scratch folders filled in. */
  command?: (c: Ctx) => string;
  /** Or the file the model asks the CLI's own write tool to write. */
  write?: (c: Ctx) => { path: string; content: string };
  /** What each approval is answered. */
  answer: 'allow' | 'reject';
  /** Stop the turn once the command started. */
  stop?: boolean;
  /** More for the turn's options (the team's protected paths). */
  extra?: (c: Ctx) => Partial<RunOptions>;
  checks: (r: Outcome, c: Ctx) => Check[];
}

/**
 * Whether a CLI's adapter refuses a shell command's write of a new file at one of the team's protected
 * paths before it happens (`RunOptions.guard`), with this permission on this system: the `guard-write`
 * scenarios fail when such a write goes through where it says so, and only warn elsewhere (the team
 * checks find it once the team has answered). Claude Code: its `Edit` deny rules, which it keeps with
 * any permission and which take a redirect it can read. Codex: its profile's `read` entries, in edit
 * mode. The open agents: Harness Relay's own sandbox,
 * below full access, on macOS only (on Linux it can keep only files that are there from being written).
 */
export function guardsShell(p: Provider, permission: Permission, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return false;
  if (p === 'claude') return permission !== 'read-only';
  // Its permission profile's `read` entries, below full access (full access has none); on Linux only for
  // a path that is there, and the scenario's is not.
  if (p === 'codex') return permission === 'edit' && platform !== 'linux';
  if (isOpenProvider(p)) return permission === 'edit' && platform === 'darwin';
  return false;
}

/**
 * Whether a CLI's adapter refuses its own write tool's write of a new file at one of the team's protected
 * paths: the `guard-tool-write` scenario fails when such a write goes through where it says so. Claude
 * Code and Copilot: rules they keep with any permission. Codex: its profile, in edit mode. Antigravity:
 * Harness Relay refuses the write when it asks about it, below full access. The open agents: Harness
 * Relay's own sandbox, as for their commands. Muse Code writes in its working directories without asking
 * (none). Cursor runs on no scripted model.
 */
export function guardsTool(p: Provider, permission: Permission, platform: NodeJS.Platform = process.platform): boolean {
  if (permission === 'read-only') return false;
  if (p === 'copilot') return true;
  if (p === 'antigravity') return permission === 'edit';
  return guardsShell(p, permission, platform);
}

/** The file the `guard-write` scenarios try to write: a protected `.env` in the working directory. */
const guardFile = (c: Ctx) => join(c.cli.work, '.env');

const guardToolWrite: Scenario = {
  name: 'guard-tool-write',
  permission: 'edit',
  write: (c) => ({ path: guardFile(c), content: 'x' }),
  answer: 'reject',
  extra: (c) => ({ guard: { dirs: [realpathSync(c.cli.work)], patterns: ['.env'] } }),
  checks: (r, c) => {
    const wrote = existsSync(guardFile(c));
    rmSync(guardFile(c), { force: true });
    const claimed = guardsTool(c.provider, 'edit');
    const called = r.requests.find((q) => q.answered.call)?.answered.call?.name;
    if (!called) {
      // Nothing was tried: a file not written proves nothing.
      return [
        {
          ok: 'warn',
          what: `the model found no write tool (offered: ${r.requests.find((q) => q.tools.length)?.tools.join(', ') || 'none'})`,
        },
        { ok: !wrote || 'warn', what: wrote ? 'the file is there, though no write tool was called' : 'nothing was tried' },
      ];
    }
    return [
      { ok: true, what: `the model called ${called}` },
      {
        ok: !wrote || (claimed ? false : 'warn'),
        what: wrote
          ? claimed
            ? "the team's protected path was written by its own tool, though its adapter says it refuses that"
            : "the team's protected path was written by its own tool: this CLI does not refuse it before (the team checks find it after)"
          : "the team's protected path was refused before its own tool wrote it",
      },
    ];
  },
};

const guardWrite = (permission: Permission): Scenario => ({
  name: permission === 'full' ? 'guard-write-full' : 'guard-write',
  permission,
  command: (c) => `echo x > ${guardFile(c)}`,
  answer: 'reject',
  extra: (c) => ({ guard: { dirs: [realpathSync(c.cli.work)], patterns: ['.env'] } }),
  checks: (r, c) => {
    const wrote = existsSync(guardFile(c));
    rmSync(guardFile(c), { force: true });
    const claimed = guardsShell(c.provider, permission);
    return [
      calledShell(r),
      {
        ok: !wrote || (claimed ? false : 'warn'),
        what: wrote
          ? claimed
            ? "the team's protected path was written, though its adapter says it refuses that"
            : "the team's protected path was written: this CLI does not refuse it before (the team checks find it after)"
          : "the team's protected path was refused before it was written",
      },
    ];
  },
});

/** The file the `hook-before` scenarios try to write, which the team's before hook refuses. */
const hookFile = (c: Ctx) => join(c.cli.work, `cli-check-hook-${c.nonce}.txt`);
/** What the scenarios' hooks print: it reaches the model only through the CLI's hooks. */
const hookMark = (c: Ctx, when: CheckHook['when']) => `HOOK-${when === 'before' ? 'REFUSED' : 'AFTER'}-${c.nonce}`;

/**
 * The team's hooks for a hook scenario (`RunOptions.hooks`): one hook on commands that prints its mark
 * and fails, run without a sandbox (what is checked is the CLI's way of asking, not Harness Relay's
 * sandbox), with this check's own gateway for a CLI that runs a hook program.
 */
function hookOptions(c: Ctx, when: CheckHook['when']): Partial<RunOptions> {
  const gateway = c.gateway;
  const hooks = turnHooks([{ id: 'check', when, tools: 'command', run: `echo ${hookMark(c, when)}; exit 1` }], {
    place: { cwds: [realpathSync(c.cli.work)], unsandboxed: true, protectedPaths: [], privateRoots: [] },
    agent: 'cli-check',
    provider: c.provider,
    notice: () => undefined,
    ...(gateway ? { program: (h) => gateway.hookProgram(h) } : {}),
  });
  return hooks ? { hooks } : {};
}

const hookBefore = (permission: Permission): Scenario => ({
  name: permission === 'full' ? 'hook-before-full' : 'hook-before',
  permission,
  command: (c) => `echo x > ${hookFile(c)}`,
  answer: 'allow',
  extra: (c) => hookOptions(c, 'before'),
  checks: (r, c) => {
    const wrote = existsSync(hookFile(c));
    rmSync(hookFile(c), { force: true });
    const runs = HOOK_PROVIDERS.includes(c.provider);
    const told = reached(r, hookMark(c, 'before'));
    if (!runs)
      return [calledShell(r), { ok: 'warn', what: wrote ? 'its adapter runs no hooks: the command ran' : 'its adapter runs no hooks' }];
    return [
      calledShell(r),
      {
        ok: !wrote,
        what: wrote ? "the command ran, though the team's before hook refused it" : "the team's before hook refused the command",
      },
      { ok: told, what: told ? "the hook's reason reached the model" : "the hook's reason never reached the model" },
    ];
  },
});

const hookAfter: Scenario = {
  name: 'hook-after',
  permission: 'edit',
  command: (c) => ECHO(c),
  answer: 'allow',
  extra: (c) => hookOptions(c, 'after'),
  checks: (r, c) => {
    const ran = reached(r, `cli-check-42-${c.nonce}`);
    const told = reached(r, hookMark(c, 'after'));
    if (!HOOK_PROVIDERS.includes(c.provider)) return [calledShell(r), { ok: 'warn', what: 'its adapter runs no hooks' }];
    return [
      calledShell(r),
      { ok: ran, what: ran ? 'the command ran, and its output reached the model' : "the command's output never reached the model" },
      { ok: told, what: told ? "the after hook's output reached the model" : "the after hook's output never reached the model" },
    ];
  },
};

export interface Ctx {
  /** A gateway of this check's own, for the hook scenarios of a CLI that runs a hook program. */
  gateway?: ToolGateway;
  provider: Provider;
  nonce: string;
  scratch: Scratch;
  cli: CliScratch;
  /** A stand-in of Harness Relay's database (a protected path), with a marker in it only this run knows. */
  secret: string;
  secretFile: string;
}

export interface Outcome {
  result?: RunResult;
  error?: string;
  aborted?: boolean;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  /** The scripted model's requests during the turn. */
  requests: ScriptedModel['requests'];
  ms: number;
  /** For a turn stopped: how many more of its command's processes are left than there were before it. */
  leftover?: number;
}

const text = (r: Outcome) =>
  r.events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { text: string }).text)
    .join('');
const tools = (r: Outcome) => r.events.filter((e) => e.type === 'tool_start') as Extract<AgentEvent, { type: 'tool_start' }>[];
const asked = (r: Outcome) => r.requests.some((q) => q.answered.call);
const reached = (r: Outcome, s: string) => r.requests.some((q) => q.raw.includes(s));
const finished = (r: Outcome): Check => ({
  ok: !r.error,
  what: r.error ? `the turn failed: ${r.error.slice(0, 200)}` : 'the turn finished',
});
const calledShell = (r: Outcome): Check =>
  asked(r)
    ? { ok: true, what: `the model called ${r.requests.find((q) => q.answered.call)!.answered.call!.name}` }
    : { ok: false, what: `the model found no shell tool (offered: ${r.requests.find((q) => q.tools.length)?.tools.join(', ') || 'none'})` };

/** A turn in a few lines: its events in order (text joined), approvals, the model's answers, how it ended. */
function timeline(r: Outcome): string[] {
  const out: string[] = [];
  let textRun = '';
  const flush = () => {
    if (textRun) out.push(`text ${JSON.stringify(textRun.slice(0, 100))}`);
    textRun = '';
  };
  for (const e of r.events) {
    if (e.type === 'text') textRun += e.text;
    else if (e.type === 'thinking' || e.type === 'text_end') continue;
    else {
      flush();
      if (e.type === 'tool_start') out.push(`tool_start ${e.name}${e.detail ? ` ${JSON.stringify(e.detail.slice(0, 80))}` : ''}`);
      else if (e.type === 'tool_end')
        out.push(`tool_end ${e.ok ? 'ok' : 'failed'}${e.error ? ` ${JSON.stringify(e.error.slice(0, 100))}` : ''}`);
      else out.push(e.type);
    }
  }
  flush();
  for (const a of r.approvals) out.push(`asked: ${a.kind} ${JSON.stringify((a.detail ?? '').slice(0, 80))}`);
  for (const q of r.requests)
    out.push(
      `model ${q.api}${q.stream ? ' (stream)' : ''}: ${q.answered.call ? `call ${q.answered.call.name}` : JSON.stringify(q.answered.text?.slice(0, 60))}`,
    );
  out.push(
    r.error
      ? `ended: ${r.aborted ? 'stopped' : 'failed'}: ${r.error.slice(0, 160)}`
      : `ended: finished in ${Math.round(r.ms / 100) / 10} s`,
  );
  return out;
}

/** Where the read-only scenario's command writes: in the working directory, named in full. */
const readOnlyFile = (c: Ctx) => join(c.cli.work, `cli-check-ro-${c.nonce}.txt`);

/**
 * Who kept the command from doing it: the check's own answer to an approval (the CLI asked, as
 * Cursor and Antigravity ask about every command), which leaves its sandbox, if it has one, untried;
 * or the sandbox or the CLI, without asking.
 */
const refusedBy = (r: Outcome): Check =>
  r.approvals.length
    ? {
        ok: 'warn',
        what: `it asked first (${r.approvals[0]!.kind}) and the check refused: what would keep it in once allowed is not tried here`,
      }
    : { ok: true, what: 'kept in without asking (its sandbox or the CLI)' };

/** A command that never ends by itself. Not `sleep`: Claude Code refuses a sleep, alone or followed by another command. */
const STOP_COMMAND = 'tail -f /dev/null';

/** Its output only: the command writes `$((6*7))`, so 42 appears only once the command ran. */
const ECHO = (c: Ctx) => `echo cli-check-$((6*7))-${c.nonce}`;

export const SCENARIOS: Scenario[] = [
  {
    name: 'reply',
    permission: 'edit',
    answer: 'reject',
    checks: (r, c) => [
      finished(r),
      {
        ok: text(r).includes(c.nonce),
        what: text(r).includes(c.nonce)
          ? 'its reply reached the chat'
          : `the reply did not reach the chat (text: ${JSON.stringify(text(r).slice(0, 120))})`,
      },
      { ok: r.requests.some((q) => q.scenario?.nonce === c.nonce), what: 'the prompt reached the model' },
    ],
  },
  {
    name: 'command',
    permission: 'edit',
    command: ECHO,
    answer: 'allow',
    checks: (r, c) => {
      const ran = reached(r, `cli-check-42-${c.nonce}`);
      return [
        finished(r),
        calledShell(r),
        { ok: ran, what: ran ? 'the command ran, and its output went back to the model' : 'the command’s output never reached the model' },
        {
          ok: tools(r).length > 0,
          what: tools(r).length ? `the chat showed the call (${tools(r)[0]!.name})` : 'the chat showed no tool call',
        },
        { ok: text(r).includes(c.nonce), what: 'the reply after it reached the chat' },
      ];
    },
  },
  {
    name: 'read-only-write',
    permission: 'read-only',
    // The file's full path: a write that lands in another folder than the one checked would go unseen.
    command: (c) => `echo x > ${readOnlyFile(c)}`,
    answer: 'reject',
    checks: (r, c) => {
      const wrote = existsSync(readOnlyFile(c));
      // A CLI that offers tools in read-only but no shell tool (Pi's run has only read, grep and ls)
      // cannot write with one. A turn that never reached the model, or was offered no tool at all, proves nothing.
      const offered = r.requests.find((q) => q.tools.length)?.tools ?? [];
      if (!asked(r) && !wrote && offered.length) {
        return [finished(r), { ok: true, what: `read-only offers no shell tool (${offered.join(', ')})` }];
      }
      return [
        calledShell(r),
        { ok: !wrote, what: wrote ? 'SECURITY: a write in read-only went through' : 'read-only kept the file from being written' },
        {
          ok: r.approvals.length ? true : 'warn',
          what: r.approvals.length ? `asked first (${r.approvals[0]!.kind})` : 'it was not asked about (refused by the sandbox or the CLI)',
        },
      ];
    },
  },
  {
    name: 'outside-write',
    permission: 'edit',
    command: (c) => `echo x > ${join(c.cli.outside, `cli-check-out-${c.nonce}.txt`)}`,
    answer: 'reject',
    checks: (r, c) => {
      const wrote = existsSync(join(c.cli.outside, `cli-check-out-${c.nonce}.txt`));
      return [
        calledShell(r),
        {
          ok: !wrote,
          what: wrote
            ? 'SECURITY: a write outside the working directory went through in edit'
            : 'edit kept the write outside the working directory from going through',
        },
        refusedBy(r),
      ];
    },
  },
  {
    name: 'protected-read',
    permission: 'edit',
    command: (c) => `cat ${c.secretFile}`,
    answer: 'reject',
    checks: (r, c) => {
      const leaked = reached(r, c.secret);
      return [
        calledShell(r),
        {
          ok: !leaked,
          what: leaked
            ? 'SECURITY: a protected file’s contents reached the model'
            : 'the protected file’s contents never reached the model',
        },
        refusedBy(r),
      ];
    },
  },
  {
    name: 'stop',
    permission: 'edit',
    command: () => STOP_COMMAND,
    answer: 'allow',
    stop: true,
    checks: (r) => [
      calledShell(r),
      {
        ok: Boolean(r.aborted),
        what: r.aborted
          ? `stopping ended the turn (${Math.round(r.ms / 100) / 10} s)`
          : `stopping did not end the turn as stopped (${r.error ?? 'it finished'})`,
      },
      {
        ok: !r.leftover,
        what: r.leftover ? `the command it started is still running (${r.leftover} left)` : 'the command it started was stopped with it',
      },
    ],
  },
  guardWrite('edit'),
  guardWrite('full'),
  guardToolWrite,
  hookBefore('edit'),
  hookBefore('full'),
  hookAfter,
];

/** The scripted model's scenarios: which name runs which command. */
function modelScenarios(ctx: Ctx): Scenarios {
  return Object.fromEntries([
    ...SCENARIOS.map(
      (s) =>
        [
          s.name,
          { ...(s.command ? { command: s.command(ctx) } : {}), ...(s.write ? { write: s.write(ctx) } : {}), thinking: true },
        ] as const,
    ),
    ['resume', { thinking: false }],
  ]);
}

// ---------------------------------------------------------------------------

/** The scenarios' results: how many failed, and each one's shape. Undefined for a CLI that has no layer 3 (`NO_RUN`). */
export interface ScenarioRun {
  failures: number;
  shapes: Record<string, Shape>;
  version?: string;
}

export async function runScenarios(
  p: Provider,
  bin: string,
  scratch: Scratch,
  cli: CliScratch,
  o: LayerOptions,
): Promise<ScenarioRun | undefined> {
  if (NO_RUN[p]) {
    console.log(`  skipped: ${NO_RUN[p]}`);
    return undefined;
  }
  const { recordSpawns, capture } = await import('../../src/server/process');
  const { openDatabase } = await import('../../src/server/db');
  const { SettingsStore } = await import('../../src/server/settings');
  const { runners, openAgents } = await import('../../src/server/agents/index');

  writeFileSync(join(cli.work, 'README.md'), '# cli-check\n');
  const nonce = randomBytes(5).toString('hex');
  const secretFile = join(scratch.data, 'relay.db');
  const secret = `RELAY-DB-${randomBytes(6).toString('hex')}`;
  writeFileSync(secretFile, secret);
  const ctx: Ctx = { provider: p, nonce, scratch, cli, secret, secretFile };
  // The hook scenarios' gateway, for a CLI that runs Harness Relay's hook program: in the scratch data folder.
  if (SCENARIOS.some((sc) => sc.name.startsWith('hook-') && (!o.only || sc.name.includes(o.only)))) {
    const { ToolGateway } = await import('../../src/server/gateway');
    const gateway = new ToolGateway(scratch.data, join(scratch.data, 'tmp'), () => process.execPath);
    await gateway.start();
    ctx.gateway = gateway;
  }

  const model = await startModel(modelScenarios(ctx));
  const place = placement(p, model.url, scratch);
  // The model's address and key in this process's environment for this CLI only: taken back at the end,
  // or a CLI checked after it in the same run would get them too.
  const before = Object.fromEntries(Object.keys(place.env ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, place.env ?? {});
  const settings = new SettingsStore(openDatabase(':memory:'));
  // OpenHands runs below full access on macOS only with a terminal in the sandbox (Settings, its card).
  settings.update(p, { bin, ...(p === 'openhands' ? { sandboxTerminal: true } : {}) });
  const env = settings.env(p);
  const runner = runners[p];

  // The flags the CLI's help lists now, against those it listed for the version checked.
  const help: string[] = [];
  for (const args of HELP_ARGS[p]) {
    const r = await capture(bin, args, env, { timeoutMs: 30_000 }).catch(() => undefined);
    if (r) help.push(r.stdout, r.stderr);
  }
  const helpFlags = new Set(flagsOf(help.join('\n')));
  const savedFlags = new Set(loadShapes(p, 'probe')?.shapes.probe?.flags ?? []);

  const shapes: Record<string, Shape> = {};
  const passed: string[] = [];
  let failures = 0;
  const want = (name: string) => !o.only || name.includes(o.only);

  const turn = async (
    name: string,
    permission: Permission,
    answer: 'allow' | 'reject',
    prompt: string,
    extra: Partial<RunOptions> = {},
    stopOnTool = false,
  ): Promise<{ outcome: Outcome; spawned: Spawned[] }> => {
    const { recorder, spawned } = memoryRecorder();
    const before = model.requests.length;
    const events: AgentEvent[] = [];
    const approvals: ApprovalRequest[] = [];
    const stop = new AbortController();
    const t0 = Date.now();
    const opts: RunOptions = {
      bin,
      env,
      prompt,
      systemPrompt: 'You are an agent in a check of Harness Relay. Do what the user asks.',
      cwd: cli.work,
      permission,
      ...(place.model ? { model: place.model } : {}),
      ...(place.backends ? { backends: place.backends } : {}),
      sandboxTerminal: settings.sandboxTerminal(p),
      signal: stop.signal,
      // No protected paths given: the adapter works them out as the server's runs do (`protectedReads()`),
      // the database in the scratch data folder among them.
      stateKey: `cli-check.${name}`,
      onEvent: (e) => {
        events.push(e);
        if (stopOnTool && e.type === 'tool_start') setTimeout(() => stop.abort(), 1500);
      },
      requestApproval: async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
        approvals.push(req);
        return answer === 'allow' ? { allow: true } : { allow: false, note: 'Not in this check.' };
      },
      ...extra,
    };
    const running = async () => {
      const r = await capture('pgrep', ['-f', STOP_COMMAND], process.env, { timeoutMs: 10_000 }).catch(() => undefined);
      return r ? r.stdout.split('\n').filter(Boolean).length : 0;
    };
    const runningBefore = stopOnTool ? await running() : 0;
    recordSpawns(recorder);
    // A turn that hangs is stopped: the CLI waits for something the script never sends.
    const limit = setTimeout(() => stop.abort(), 3 * 60_000);
    let outcome: Outcome;
    try {
      const result = await runner.run(opts);
      outcome = { result, events, approvals, requests: model.requests.slice(before), ms: Date.now() - t0 };
    } catch (err) {
      const e = err as Error & { aborted?: boolean };
      outcome = {
        error: e.message,
        aborted: Boolean(e.aborted) || stop.signal.aborted,
        events,
        approvals,
        requests: model.requests.slice(before),
        ms: Date.now() - t0,
      };
    } finally {
      clearTimeout(limit);
      recordSpawns(undefined);
    }
    // Every request the model was sent, as the CLI sent it, in the scratch folder (kept with --keep).
    appendFileSync(
      join(scratch.root, 'model-requests.jsonl'),
      outcome.requests.map((q) => JSON.stringify({ scenario: name, ...q }) + '\n').join(''),
    );
    if (stopOnTool) {
      // The process group gets its SIGKILL a few seconds after its SIGTERM (`KILL_GRACE_MS`).
      await new Promise((r) => setTimeout(r, 4_000));
      outcome.leftover = Math.max(0, (await running()) - runningBefore);
    }
    return { outcome, spawned };
  };

  const report = (name: string, checks: Check[], spawned: Spawned[], outcomes: Outcome[]) => {
    const bad = checks.filter((c) => c.ok === false);
    failures += bad.length ? 1 : 0;
    console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${name}`);
    for (const c of checks) console.log(`       ${c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'} ${c.what}`);
    // What happened, for a scenario that failed: the turn's events, approvals and the model's answers.
    if (bad.length) for (const r of outcomes) for (const l of timeline(r)) console.log(`         ${l}`);
    // A flag the adapter passes that the version checked listed and this one does not.
    for (const s of spawned.filter((x) => x.bin === bin)) {
      for (const f of flagsIn(s.args)) {
        if (savedFlags.has(f) && !helpFlags.has(f))
          console.log(`       ✗ the adapter passes ${f}, which this version's help no longer lists`);
      }
    }
    if (!bad.length) passed.push(name);
  };

  try {
    // A CLI Harness Relay runs only with full access on this system (OpenCode on Linux: its adapter's
    // `sandboxUnsupported`): its scenarios run with full access, and those below it say nothing.
    const fullOnly = isOpenProvider(p) ? openAgents[p].process.sandboxUnsupported?.(process.platform) : undefined;
    if (fullOnly) console.log(`  ! ${fullOnly.split(':')[0]}: its scenarios run with full access, and those below it are not run`);
    for (const sc of SCENARIOS) {
      if (!want(sc.name)) continue;
      if (fullOnly && BELOW_FULL.includes(sc.name)) {
        console.log(`  --   ${sc.name}: not run (it runs only with full access here)`);
        continue;
      }
      const { outcome, spawned } = await turn(
        sc.name,
        fullOnly ? 'full' : sc.permission,
        sc.answer,
        `${marker(sc.name, nonce)} Please do the task of this check.`,
        sc.extra?.(ctx) ?? {},
        sc.stop,
      );
      report(sc.name, sc.checks(outcome, ctx), spawned, [outcome]);
      shapes[sc.name] = shapeOf(spawned);
    }
    if (want('resume')) {
      // Two turns of one member: the second resumes the first's session, and its request to the model holds the first turn.
      const first = await turn('resume', fullOnly ? 'full' : 'edit', 'reject', `${marker('reply', `${nonce}a`)} Remember this.`);
      const id = first.outcome.result?.sessionId;
      const second = id
        ? await turn('resume', fullOnly ? 'full' : 'edit', 'reject', `${marker('resume', `${nonce}b`)} What did I say first?`, {
            sessionId: id,
          })
        : undefined;
      const checks: Check[] = [
        {
          ok: Boolean(id),
          what: id
            ? 'the first turn gave a session'
            : `the first turn gave no session${first.outcome.error ? `: ${first.outcome.error.slice(0, 160)}` : ''}`,
        },
      ];
      if (second) {
        checks.push(finished(second.outcome));
        const held = reached(second.outcome, `${nonce}a`);
        checks.push({
          ok: held,
          what: held ? 'the resumed session held the earlier turn' : 'the resumed session did not hold the earlier turn',
        });
      }
      report('resume', checks, [...first.spawned, ...(second?.spawned ?? [])], [first.outcome, ...(second ? [second.outcome] : [])]);
      shapes.resume = shapeOf([...first.spawned, ...(second?.spawned ?? [])]);
    }
  } finally {
    await model.close();
    await ctx.gateway?.stop();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  if (model.unknown.length)
    console.log(`  ! the CLI asked the scripted model for what it does not serve: ${[...new Set(model.unknown)].join(', ')}`);
  console.log(`  ${passed.length} of ${passed.length + failures} scenarios passed`);

  const version = await capture(bin, ['--version'], env, { timeoutMs: 30_000 })
    .then((r) => (r.stdout || r.stderr).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0]?.replace(/[.-]+$/, ''))
    .catch(() => undefined);
  return { failures, shapes, ...(version ? { version } : {}) };
}
