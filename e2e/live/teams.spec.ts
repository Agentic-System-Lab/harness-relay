import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { CLOUD, CLOUD_CLIS, ENDPOINTS, ENDPOINT_CLIS, OPEN, askPermission, editPermission, folder, has, homeFolder, liveTurn, modelId, ownModel, setUpEndpoints, type LiveMember } from './live';

test.use({ live: true });

/** A path with forward slashes, which every shell takes (Git Bash, which Pi uses on Windows, reads a backslash as an escape). */
const slashes = (path: string) => path.replace(/\\/g, '/');

test.describe('a team on cloud and local models together', () => {
  test.skip(!CLOUD || !ENDPOINTS.length, 'needs E2E_LIVE_CLOUD=1 and an endpoint');

  test("CLIs on their own models, and CLIs on the user's own: each answers", async ({ relay }) => {
    await setUpEndpoints(relay);
    // Up to three on their own service (Claude Code first), then two on the user's endpoints, of CLIs
    // not already in the team: five members at most, within the team's limit.
    const cloud = CLOUD_CLIS.filter(has).slice(0, 3);
    const members: LiveMember[] = [
      ...cloud.map((provider, i) => ({ provider, name: `Cloud${i + 1}`, ...(ownModel(provider) ? { model: ownModel(provider) } : {}) })),
      ...[...OPEN, ...ENDPOINT_CLIS]
        .filter((p) => has(p) && !(cloud as readonly string[]).includes(p))
        .slice(0, 2)
        .map((provider, i) => ({ provider, name: `Local${i + 1}`, model: modelId(ENDPOINTS[i % ENDPOINTS.length]!) })),
    ];
    test.skip(members.length < 2, 'needs two CLIs');
    // Every member below full access answers, but an open agent on Windows (full access only).
    const permission = members.some((m) => askPermission(m.provider) === 'full') ? 'full' : 'read-only';
    // A question for each (a member with nothing to add to the others' answers would pass).
    const questions = [
      ['France', /paris/i],
      ['Japan', /tokyo/i],
      ['Italy', /rome|roma/i],
      ['Spain', /madrid/i],
      ['Kenya', /nairobi/i],
    ] as const;
    const text = members.map((m, i) => `@${m.name} what is the capital of ${questions[i]![0]}?`).join(' ') + ' Each of you, answer only your own question, in one word.';
    const r = await liveTurn(relay, members, text, { cwd: folder(relay, 'mixed'), permission, approvals: 'deny' });
    r.replies.forEach((reply, i) => {
      expect(reply.error, `${reply.name} failed`).toBeUndefined();
      expect(reply.status, reply.name).toBe('done');
      expect(reply.text, reply.name).toMatch(questions[i]![1]);
    });
  });
});

test.describe("writing in each of a chat's working directories", () => {
  const first = ENDPOINTS[0];
  const writers: LiveMember[] = [
    ...[...ENDPOINT_CLIS, ...OPEN].filter(has).flatMap((provider) => (first ? [{ provider, model: modelId(first) }] : [])),
    // On their own models: Claude Code, Codex and Grok in their own sandboxes; Cursor and Antigravity, which
    // have none, asking before each command (allowed: `echo hi >`).
    ...(CLOUD ? CLOUD_CLIS.filter(has).map((provider) => ({ provider, ...(ownModel(provider) ? { model: ownModel(provider) } : {}) })) : []),
  ];
  test.skip(!writers.length, 'needs an endpoint, or E2E_LIVE_CLOUD=1');

  for (const w of writers) {
    test(`${w.provider}${w.model ? ` on ${w.model}` : ''}: one file in each folder, through its shell`, async ({ relay }) => {
      await setUpEndpoints(relay);
      const dirs = [folder(relay, 'app'), folder(relay, 'docs')];
      const second = join(dirs[1]!, 'hello2.txt');
      const r = await liveTurn(
        relay,
        [{ provider: w.provider, ...(w.model ? { model: w.model } : {}), name: 'Ada' }],
        `Use your shell tool to run these two commands, one after the other, exactly as written:\n1. echo hi > hello.txt\n2. echo hi > ${slashes(second)}\nThen reply with the word DONE.`,
        { cwd: dirs[0]!, extraCwds: [dirs[1]!], permission: editPermission(w.provider), approvals: 'ask' },
      );
      const calls = `tools: ${r.tools.join('; ') || 'none'}; approvals: ${r.approvals.map((a) => `${a.kind} ${a.detail ?? ''}`).join('; ') || 'none'}; reply: ${r.replies[0]?.text.slice(0, 200)}`;
      expect(r.replies[0]?.error, 'the turn failed').toBeUndefined();
      expect(existsSync(join(dirs[0]!, 'hello.txt')), `the first folder; ${calls}`).toBe(true);
      expect(existsSync(second), `the second folder; ${calls}`).toBe(true);
    });
  }

  test('Cursor: a file in the second folder through its own file tool, asked first', async ({ relay }) => {
    test.skip(!CLOUD || !has('cursor'), 'needs E2E_LIVE_CLOUD=1 and Cursor');
    // Not in a temporary folder, where Cursor's own tools write without asking.
    const home = homeFolder();
    try {
      const dirs = [join(home.dir, 'app'), join(home.dir, 'docs')];
      for (const d of dirs) mkdirSync(d);
      const second = join(dirs[1]!, 'notes.md');
      const r = await liveTurn(
        relay,
        [{ provider: 'cursor', name: 'Ada' }],
        `Without using the shell, use your file editing tool to create two files: notes.md in the current folder, and ${second}. Each holds the single line: hello. Then reply DONE.`,
        { cwd: dirs[0]!, extraCwds: [dirs[1]!], permission: 'edit', approvals: 'ask' },
      );
      const calls = `tools: ${r.tools.join('; ')}`;
      expect(r.replies[0]?.error, 'the turn failed').toBeUndefined();
      expect(existsSync(join(dirs[0]!, 'notes.md')), `the first folder; ${calls}`).toBe(true);
      expect(existsSync(second), `the second folder; ${calls}`).toBe(true);
      // The write in the second folder was asked, the card saying where it is.
      expect(r.approvals.map((a) => a.reason ?? ''), calls).toContainEqual(expect.stringMatching(/another of the chat's working directories/));
    } finally {
      home.remove();
    }
  });
});

test.describe('Antigravity', () => {
  test.skip(!CLOUD || !has('antigravity'), 'needs E2E_LIVE_CLOUD=1 and Antigravity (signed in with Google, or GEMINI_API_KEY)');

  test('antigravity: a refused command ends its turn, and the chat says so', async ({ relay }) => {
    const dir = folder(relay, 'refused');
    const model = ownModel('antigravity');
    // `echo no >` is not among what the live tests allow (liveAllows), so the command is refused.
    const r = await liveTurn(
      relay,
      [{ provider: 'antigravity', name: 'Ada', ...(model ? { model } : {}) }],
      'Use your shell tool to run exactly this command: echo no > refused.txt\nThen reply with the word DONE.',
      { cwd: dir, permission: 'edit', approvals: 'ask' },
    );
    const calls = `tools: ${r.tools.join('; ') || 'none'}; approvals: ${r.approvals.map((a) => `${a.kind} ${a.detail ?? ''}`).join('; ') || 'none'}`;
    expect(r.approvals.some((a) => a.kind === 'command' && !a.allowed), `the command was asked about; ${calls}`).toBe(true);
    expect(existsSync(join(dir, 'refused.txt')), calls).toBe(false);
    // agy ends its turn at a refusal, telling the model nothing: the call says so, and nothing follows it.
    expect(r.tools.join('\n'), calls).toContain('Antigravity ends its turn after a refusal');
    expect(r.replies[0]?.error, 'the turn failed').toBeUndefined();
    expect(r.replies[0]?.text ?? '', calls).not.toMatch(/\bDONE\b/);
  });

  test("antigravity: a project's own MCP server is asked about before agy starts, and refused, never runs", async ({ relay }) => {
    const dir = folder(relay, 'project');
    const marker = join(relay.root, 'live', 'mcp-ran');
    // A project MCP server agy would start as its session opens, outside any sandbox: it leaves a marker.
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(
      join(dir, '.agents', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { marker: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`] } } }),
    );
    const r = await liveTurn(relay, [{ provider: 'antigravity', name: 'Ada' }], 'Say hello.', { cwd: dir, permission: 'read-only', approvals: 'ask' });
    expect(r.approvals.map((a) => `${a.kind} ${a.detail ?? ''}`)).toContainEqual(expect.stringMatching(/^other .*mcp_config\.json/));
    expect(r.replies[0]?.error ?? '').toMatch(/The turn did not start: this project has setup Antigravity would run by itself/);
    expect(existsSync(marker)).toBe(false);
  });
});

test.describe('Copilot', () => {
  const first = ENDPOINTS[0];
  /** On the user's own endpoint when there is one, else on its own service (E2E_LIVE_CLOUD=1). */
  const member = (): LiveMember => (first ? { provider: 'copilot', name: 'Ada', model: modelId(first) } : { provider: 'copilot', name: 'Ada', ...(ownModel('copilot') ? { model: ownModel('copilot') } : {}) });
  test.skip(!has('copilot') || (!first && !CLOUD), 'needs Copilot, and an endpoint or E2E_LIVE_CLOUD=1');

  test('copilot: a refused command ends its turn, and the chat says so', async ({ relay }) => {
    await setUpEndpoints(relay);
    const dir = folder(relay, 'refused');
    // In read-only it asks before a command that writes, which the live tests refuse (liveAllows).
    const r = await liveTurn(relay, [member()], 'Use your shell tool to run exactly this command: echo no > refused.txt\nThen reply with the word DONE.', {
      cwd: dir,
      permission: 'read-only',
      approvals: 'ask',
    });
    const calls = `tools: ${r.tools.join('; ') || 'none'}; approvals: ${r.approvals.map((a) => `${a.kind} ${a.detail ?? ''}`).join('; ') || 'none'}`;
    test.skip(!r.tools.length && !r.approvals.length, `the model did not try the command; ${calls}`);
    expect(r.approvals.some((a) => a.kind === 'command' && !a.allowed), `the command was asked about; ${calls}`).toBe(true);
    expect(existsSync(join(dir, 'refused.txt')), calls).toBe(false);
    // Copilot ends its turn at a refusal: the call says so, and nothing follows it.
    expect(r.tools.join('\n'), calls).toContain('Copilot ends its turn after a refusal');
    expect(r.replies[0]?.error, 'the turn failed').toBeUndefined();
    expect(r.replies[0]?.text ?? '', calls).not.toMatch(/\bDONE\b/);
  });

  test("copilot: a project's own hook is asked about before copilot starts, and refused, never runs", async ({ relay }) => {
    await setUpEndpoints(relay);
    const dir = folder(relay, 'project');
    const marker = join(relay.root, 'live', 'hook-ran');
    // A project hook Copilot would run as its session opens, without asking: it leaves a marker.
    mkdirSync(join(dir, '.github', 'hooks'), { recursive: true });
    const run = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, '')`)}`;
    writeFileSync(join(dir, '.github', 'hooks', 'marker.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: run, powershell: `& ${run}`, timeoutSec: 30 }] } }));
    const r = await liveTurn(relay, [member()], 'Say hello.', { cwd: dir, permission: 'read-only', approvals: 'ask' });
    expect(r.approvals.map((a) => `${a.kind} ${a.detail ?? ''}`)).toContainEqual(expect.stringMatching(/^other .*marker\.json/));
    expect(r.replies[0]?.error ?? '').toMatch(/The turn did not start: this project has hooks Copilot would run by itself/);
    expect(existsSync(marker)).toBe(false);
  });
});
