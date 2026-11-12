import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { CLOUD, ENDPOINTS, ENDPOINT_CLIS, OPEN, askPermission, editPermission, folder, has, homeFolder, liveTurn, modelId, setUpEndpoints, type LiveMember } from './live';

test.use({ live: true });

/** A path with forward slashes, which every shell takes (Git Bash, which Pi uses on Windows, reads a backslash as an escape). */
const slashes = (path: string) => path.replace(/\\/g, '/');

test.describe('a team on cloud and local models together', () => {
  test.skip(!CLOUD || !ENDPOINTS.length, 'needs E2E_LIVE_CLOUD=1 and an endpoint');

  test("Claude Code on its own model, and CLIs on the user's own: each answers", async ({ relay }) => {
    await setUpEndpoints(relay);
    const members: LiveMember[] = [
      ...(has('claude') ? [{ provider: 'claude' as const, name: 'Cloud' }] : []),
      ...[...OPEN, ...ENDPOINT_CLIS.filter((p) => p !== 'claude')]
        .filter(has)
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
    ...(CLOUD && has('cursor') ? [{ provider: 'cursor' as const }] : []),
  ];
  test.skip(!writers.length, 'needs an endpoint, or E2E_LIVE_CLOUD=1 and Cursor');

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
