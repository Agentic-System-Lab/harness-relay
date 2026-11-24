/*
 * The cards a finished reply leaves the user without (src/server/handoffGaps.ts): the scripts a turn
 * wrote that read $RELAY_SECRETS_FILE, read from a real git repository's snapshots as the orchestrator
 * keeps a turn's changes, and which of them no fixed command runs; the secrets a proposed command names
 * that nobody asks for.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GAP_LIMITS, handoffGaps, secretsScripts } from '../src/server/handoffGaps';
import { diffFiles, ensureRepo, snapshot } from '../src/server/workspace';
import type { MessageChanges } from '../src/shared/types';

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'relay-gaps-')));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** What a turn changed, as the orchestrator keeps it: `turn` writes between two snapshots. */
async function changesOf(turn: () => void): Promise<MessageChanges[]> {
  const { root } = await ensureRepo(repo);
  const before = await snapshot(root);
  turn();
  const after = await snapshot(root);
  return [{ root, base: before.commit, head: after.commit, files: await diffFiles(root, before.commit, after.commit), isolated: false }];
}

describe('secretsScripts', () => {
  it('finds the scripts a turn wrote that read $RELAY_SECRETS_FILE, from the working directory', async () => {
    mkdirSync(join(repo, 'titanic'));
    writeFileSync(join(repo, 'old.py'), 'print("old")\n');
    const changes = await changesOf(() => {
      writeFileSync(join(repo, 'titanic', 'download.py'), 'import os\nfor line in open(os.environ["RELAY_SECRETS_FILE"]):\n    pass\n');
      writeFileSync(join(repo, 'titanic', 'train.py'), 'print("train")\n');
      // Prose that tells how the command reads its secrets runs nothing.
      writeFileSync(join(repo, 'titanic', 'README.md'), 'download.py reads $RELAY_SECRETS_FILE.\n');
      writeFileSync(join(repo, 'notes.txt'), 'RELAY_SECRETS_FILE\n');
      // Nor does a binary file, whatever bytes it holds.
      writeFileSync(join(repo, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('RELAY_SECRETS_FILE')]));
      writeFileSync(join(repo, 'post.sh'), '#!/bin/sh\n. "$RELAY_SECRETS_FILE"\n');
    });
    expect((await secretsScripts(changes, repo)).sort()).toEqual(['post.sh', 'titanic/download.py']);
    // From a working directory below the repository's root: paths from there, and absolute outside it.
    expect((await secretsScripts(changes, join(repo, 'titanic'))).sort()).toEqual([
      join(repo, 'post.sh').split('\\').join('/'),
      'download.py',
    ]);
  });

  it('finds a script whose changed lines read it, never one edited elsewhere, one that no longer reads it or one deleted', async () => {
    writeFileSync(join(repo, 'post.py'), 'print(1)\n');
    writeFileSync(join(repo, 'kept.py'), 'import os\nopen(os.environ["RELAY_SECRETS_FILE"])\nprint(1)\n');
    writeFileSync(join(repo, 'dropped.py'), 'import os\nopen(os.environ["RELAY_SECRETS_FILE"])\n');
    writeFileSync(join(repo, 'gone.py'), 'open(os.environ["RELAY_SECRETS_FILE"])\n');
    const changes = await changesOf(() => {
      writeFileSync(join(repo, 'post.py'), 'import os\nopen(os.environ["RELAY_SECRETS_FILE"])\n');
      // Checked when that line was written: an edit elsewhere in it is not news.
      writeFileSync(join(repo, 'kept.py'), 'import os\nopen(os.environ["RELAY_SECRETS_FILE"])\nprint(2)\n');
      writeFileSync(join(repo, 'dropped.py'), 'print("no secrets now")\n');
      rmSync(join(repo, 'gone.py'));
    });
    expect(await secretsScripts(changes, repo)).toEqual(['post.py']);
    expect(await secretsScripts(undefined, repo)).toEqual([]);
  });

  it(`reads at most ${GAP_LIMITS.files} of them`, async () => {
    const changes = await changesOf(() => {
      for (let i = 0; i <= GAP_LIMITS.files; i++) writeFileSync(join(repo, `s${String(i).padStart(2, '0')}.py`), 'RELAY_SECRETS_FILE\n');
    });
    expect(await secretsScripts(changes, repo)).toHaveLength(GAP_LIMITS.files);
  });
});

describe('handoffGaps', () => {
  it('names each script no fixed command runs, by its file name in a command line', () => {
    expect(
      handoffGaps({
        scripts: ['titanic/download.py', 'tools/post.sh', 'lib/secrets.py'],
        commands: [{ run: 'cd tools && sh ./post.sh --dry-run' }, { run: 'python3 other.py' }],
        proposed: [],
        asked: new Set(),
      }),
    ).toEqual([
      { kind: 'script', path: 'titanic/download.py' },
      { kind: 'script', path: 'lib/secrets.py' },
    ]);
    expect(
      handoffGaps({ scripts: ['titanic/download.py'], commands: [{ run: 'python3 titanic/download.py' }], proposed: [], asked: new Set() }),
    ).toEqual([]);
    // A name that only begins the same is not the script's.
    expect(handoffGaps({ scripts: ['post.py'], commands: [{ run: 'python3 post.py.bak' }], proposed: [], asked: new Set() })).toEqual([
      { kind: 'script', path: 'post.py' },
    ]);
  });

  it('names each secret a proposed command needs that is neither kept nor asked for, once', () => {
    expect(
      handoffGaps({
        scripts: [],
        commands: [],
        proposed: [
          { name: 'post', secrets: ['TOKEN', 'APP_SECRET', 'KEPT'] },
          { name: 'refresh', secrets: ['TOKEN', 'REFRESH'] },
        ],
        asked: new Set(['APP_SECRET', 'KEPT']),
      }),
    ).toEqual([
      { kind: 'secret', name: 'TOKEN', command: 'post' },
      { kind: 'secret', name: 'REFRESH', command: 'refresh' },
    ]);
  });
});
