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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalAnswer, Permission, Provider } from '../../src/shared/types';
import type { AgentEvent, ApprovalRequest, RunOptions, RunResult } from '../../src/server/agents/types';
import { compareShapes, loadShapes } from './layers';
import type { LayerOptions } from './layers';
import { MODEL, MUSE_MODEL, marker, startModel, type ScriptedModel } from './model';
import { HELP_ARGS } from './probe';
import type { CliScratch, Scratch } from './scratch';
import { flagsIn, flagsOf, memoryRecorder, shapeOf, type Shape, type Spawned } from './shape';

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
  /** What each approval is answered. */
  answer: 'allow' | 'reject';
  /** Stop the turn once the command started. */
  stop?: boolean;
  checks: (r: Outcome, c: Ctx) => Check[];
}

interface Ctx {
  nonce: string;
  scratch: Scratch;
  cli: CliScratch;
  /** A stand-in of Harness Relay's database (a protected path), with a marker in it only this run knows. */
  secret: string;
  secretFile: string;
}

interface Outcome {
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
    command: (c) => `echo x > cli-check-ro-${c.nonce}.txt`,
    answer: 'reject',
    checks: (r, c) => {
      const wrote = existsSync(join(c.cli.work, `cli-check-ro-${c.nonce}.txt`));
      // A CLI that offers no shell tool in read-only (Pi's run has only read, grep and ls) cannot write with one.
      const offered = r.requests.find((q) => q.tools.length)?.tools ?? [];
      if (!asked(r) && !wrote) return [{ ok: true, what: `read-only offers no shell tool (${offered.join(', ') || 'none'})` }];
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
];

/** The scripted model's scenarios: which name runs which command. */
function modelScenarios(ctx: Ctx): Record<string, { command?: string; thinking?: boolean }> {
  return Object.fromEntries([
    ...SCENARIOS.map((s) => [s.name, { ...(s.command ? { command: s.command(ctx) } : {}), thinking: true }] as const),
    ['resume', { thinking: false }],
  ]);
}

// ---------------------------------------------------------------------------

export async function runScenarios(p: Provider, bin: string, scratch: Scratch, cli: CliScratch, o: LayerOptions): Promise<number> {
  if (NO_RUN[p]) {
    console.log(`  skipped: ${NO_RUN[p]}`);
    return 0;
  }
  const { recordSpawns, capture, runProcess } = await import('../../src/server/process');
  const { openDatabase } = await import('../../src/server/db');
  const { SettingsStore } = await import('../../src/server/settings');
  const { runners } = await import('../../src/server/agents/index');

  await runProcess({ bin: 'git', args: ['init', '-q'], cwd: cli.work, env: process.env, timeoutMs: 30_000 });
  writeFileSync(join(cli.work, 'README.md'), '# cli-check\n');
  const nonce = randomBytes(5).toString('hex');
  const secretFile = join(scratch.data, 'relay.db');
  const secret = `RELAY-DB-${randomBytes(6).toString('hex')}`;
  writeFileSync(secretFile, secret);
  const ctx: Ctx = { nonce, scratch, cli, secret, secretFile };

  const model = await startModel(modelScenarios(ctx));
  const place = placement(p, model.url, scratch);
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
    for (const sc of SCENARIOS) {
      if (!want(sc.name)) continue;
      const { outcome, spawned } = await turn(
        sc.name,
        sc.permission,
        sc.answer,
        `${marker(sc.name, nonce)} Please do the task of this check.`,
        {},
        sc.stop,
      );
      report(sc.name, sc.checks(outcome, ctx), spawned, [outcome]);
      shapes[sc.name] = shapeOf(spawned);
    }
    if (want('resume')) {
      // Two turns of one member: the second resumes the first's session, and its request to the model holds the first turn.
      const first = await turn('resume', 'edit', 'reject', `${marker('reply', `${nonce}a`)} Remember this.`);
      const id = first.outcome.result?.sessionId;
      const second = id
        ? await turn('resume', 'edit', 'reject', `${marker('resume', `${nonce}b`)} What did I say first?`, { sessionId: id })
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
  }

  if (model.unknown.length)
    console.log(`  ! the CLI asked the scripted model for what it does not serve: ${[...new Set(model.unknown)].join(', ')}`);
  console.log(`  ${passed.length} of ${passed.length + failures} scenarios passed`);

  // The recordings' shapes, against those saved for the version checked.
  const version = await capture(bin, ['--version'], env, { timeoutMs: 30_000 })
    .then((r) => (r.stdout || r.stderr).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0]?.replace(/[.-]+$/, ''))
    .catch(() => undefined);
  console.log('  shapes:');
  // Shapes are saved only from a run that passed: a failed one would be what later versions are held to.
  const changed = compareShapes(p, 'run', version, shapes, o.accept && !failures);
  if (o.accept && failures) console.log('    not saved: a scenario failed');
  return failures || changed ? 1 : 0;
}
