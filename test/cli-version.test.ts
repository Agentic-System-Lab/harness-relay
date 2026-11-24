import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { removeTree } from '../src/server/fsRemove';
import { slow } from './timeouts';
import { CHECKED_VERSIONS, MIN_VERSIONS, tooOldFor, versionBefore } from '../src/shared/cliVersions';
import { PROVIDER_LABEL, PROVIDERS, isOpenProvider, type Provider } from '../src/shared/types';

const root = mkdtempSync(join(tmpdir(), 'relay-cli-version-'));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => removeTree(root));

const { assertNotTooOld, CliKilledError, CliTooOldError, cliVersion, forgetVersions, parseVersion, tooOld } =
  await import('../src/server/cliVersion');
const { newEnoughOnly } = await import('../src/server/agents/index');
const { AgentRunError } = await import('../src/server/agents/types');
const { t } = await import('../src/server/i18n');

describe('comparing versions', () => {
  it('compares their numbers, however the CLI writes them', () => {
    expect(versionBefore('0.27.0', '0.167.0')).toBe(true);
    expect(versionBefore('0.167.0', '0.27.0')).toBe(false);
    expect(versionBefore('0.167.0', '0.167.0')).toBe(false);
    expect(versionBefore('1.0', '1.0.1')).toBe(true);
    expect(versionBefore('1.0.0', '1.0')).toBe(false);
    // Cursor's dated builds, and Muse Code's build after its version.
    expect(versionBefore('2026.1.15-1a2b3c4', '2026.11.11-043ef28')).toBe(true);
    expect(versionBefore('1.4.18 (1.4.18-R8587.1)', '1.4.9')).toBe(false);
  });

  it('leaves a suffix out: a pre-release of the minimum is new enough', () => {
    expect(versionBefore('0.168.0-alpha.2', '0.168.0')).toBe(false);
  });

  it('cannot tell without numbers', () => {
    expect(versionBefore('unknown', '1.0.0')).toBeUndefined();
    expect(versionBefore('1.0.0', '')).toBeUndefined();
  });
});

describe('the oldest versions Harness Relay supports', () => {
  it('are never newer than the versions it was checked with', () => {
    for (const p of PROVIDERS) {
      const min = MIN_VERSIONS[p];
      if (min) expect(versionBefore(CHECKED_VERSIONS[p], min), `${p}: ${min} after ${CHECKED_VERSIONS[p]}`).toBe(false);
    }
  });

  it('are what the user guide says each CLI needs, in both languages', () => {
    const commands: Record<Provider, string> = {
      claude: 'claude',
      codex: 'codex',
      grok: 'grok',
      cursor: 'cursor-agent',
      antigravity: 'agy',
      copilot: 'copilot',
      muse: 'muse',
      opencode: 'opencode',
      goose: 'goose',
      cline: 'cline',
      openhands: 'openhands',
      pi: 'pi',
    };
    for (const [doc, needs] of [
      ['docs/user-guide.md', (v: string) => [`needs ${v} or later`, `| ${v} |`]],
      ['docs/user-guide.zh-TW.md', (v: string) => [`需要 ${v} 以上`, `| ${v} |`]],
    ] as const) {
      const lines = readFileSync(join(import.meta.dirname, '..', doc), 'utf8').split('\n');
      for (const p of PROVIDERS) {
        const min = MIN_VERSIONS[p];
        // The CLI's line in "Installing the agent CLIs": a list item or a table row naming its command.
        const line = lines.find((l) => /^(- \[|\| \[)/.test(l) && new RegExp(`[（(]\`${commands[p]}\``).test(l));
        expect(line, `${doc}: ${p}`).toBeDefined();
        if (min)
          expect(
            needs(min).some((s) => line!.includes(s)),
            `${doc}: ${p} needs ${min}`,
          ).toBe(true);
      }
    }
  });

  it('call a CLI too old only below its minimum, and only when its version can be read', () => {
    expect(tooOldFor('codex', '0.27.0')).toBe(MIN_VERSIONS.codex);
    expect(tooOldFor('codex', CHECKED_VERSIONS.codex)).toBeUndefined();
    expect(tooOldFor('codex', MIN_VERSIONS.codex)).toBeUndefined();
    expect(tooOldFor('codex', undefined)).toBeUndefined();
    expect(tooOldFor('codex', 'dev build')).toBeUndefined();
    const without = PROVIDERS.find((p) => !MIN_VERSIONS[p]);
    if (without) expect(tooOldFor(without, '0.0.1')).toBeUndefined();
  });
});

describe('parseVersion', () => {
  it("finds the version in each CLI's --version", () => {
    expect(parseVersion('codex-cli 0.27.0\n')).toBe('0.27.0');
    expect(parseVersion('2.1.0 (Claude Code)')).toBe('2.1.0');
    expect(parseVersion('GitHub Copilot CLI 1.0.109.')).toBe('1.0.109');
    expect(parseVersion('\x1b[1m2026.11.11-043ef28\x1b[0m')).toBe('2026.11.11-043ef28');
    expect(parseVersion('no version here')).toBeUndefined();
  });
});

const posix = process.platform === 'win32' ? describe.skip : describe;

posix("a CLI's version, read from its program", () => {
  beforeEach(() => forgetVersions());

  /** A stand-in CLI that prints `version` and counts its starts in `<bin>.starts`. */
  const fake = (name: string, version: string, otherwise = 'echo "started for $*"') => {
    const bin = join(root, name);
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$*" >> "${bin}.starts"\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n${otherwise}\n`,
      { mode: 0o755 },
    );
    return bin;
  };
  const starts = (bin: string) => {
    try {
      return readFileSync(`${bin}.starts`, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };

  it('is asked once while the program stays the same, and again when it changes or when asked fresh', async () => {
    const bin = fake('codex-kept', 'codex-cli 0.27.0');
    expect(await cliVersion(bin, process.env)).toBe('0.27.0');
    expect(await cliVersion(bin, process.env)).toBe('0.27.0');
    expect(starts(bin)).toEqual(['--version']);
    expect(await cliVersion(bin, process.env, true)).toBe('0.27.0');
    expect(starts(bin)).toHaveLength(2);
    // Updated in place: another file (its size and time), asked again.
    fake('codex-kept', 'codex-cli 0.167.0');
    utimesSync(bin, new Date(), new Date(Date.now() + 5000));
    expect(await cliVersion(bin, process.env)).toBe('0.167.0');
    expect(starts(bin)).toHaveLength(3);
  });

  it('finds a command on the PATH, as the CLI is started', async () => {
    const dir = mkdtempSync(join(root, 'path-'));
    const bin = join(dir, 'codex');
    writeFileSync(bin, '#!/bin/sh\necho "codex-cli 0.27.0"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin` };
    expect(await tooOld('codex', 'codex', env)).toEqual({ version: '0.27.0', min: MIN_VERSIONS.codex });
  });

  it('calls a CLI too old with the version it needs, and refuses it in the request language', async () => {
    const bin = fake('codex-old', 'codex-cli 0.27.0');
    const old = { version: '0.27.0', min: MIN_VERSIONS.codex! };
    expect(await tooOld('codex', bin, process.env)).toEqual(old);
    const err = await assertNotTooOld('codex', bin, process.env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliTooOldError);
    expect((err as Error).message).toBe(t().cliTooOld('Codex', '0.27.0', MIN_VERSIONS.codex!));
  });

  it('does not call a CLI too old when it cannot tell: not there, or no version in its answer', async () => {
    expect(await tooOld('codex', join(root, 'no-such-codex'), process.env)).toBeUndefined();
    const bin = fake('codex-no-version', 'codex dev build');
    expect(await tooOld('codex', bin, process.env)).toBeUndefined();
    await expect(assertNotTooOld('codex', bin, process.env)).resolves.toBeUndefined();
  });

  it('says a program killed as it started (macOS, a revoked signature) was, and asks it again next time', async () => {
    const bin = fake('codex-killed', 'never said', '');
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${bin}.starts"\nkill -9 $$\n`, { mode: 0o755 });
    const err = await cliVersion(bin, process.env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliKilledError);
    expect((err as Error).message).toBe(t().cliKilledAtStart('SIGKILL'));
    // Refused as it is (its version is not known), and not kept: asked again next time.
    await expect(tooOld('codex', bin, process.env)).rejects.toBeInstanceOf(CliKilledError);
    expect(starts(bin)).toEqual(['--version', '--version']);
  });

  it('asks a program that could not be started again next time', async () => {
    const bin = join(root, 'codex-later');
    await expect(cliVersion(bin, process.env)).rejects.toThrow();
    fake('codex-later', 'codex-cli 0.27.0');
    expect(await cliVersion(bin, process.env)).toBe('0.27.0');
  });

  /** What a run is started with: only the program and its environment matter here. */
  const options = (bin: string) =>
    ({ bin, env: process.env, prompt: 'hi', systemPrompt: '', cwd: root, permission: 'read' }) as unknown as Parameters<
      ReturnType<typeof newEnoughOnly>['run']
    >[0];

  describe('every runner Harness Relay starts runs through', () => {
    /** A stand-in that says `version` and logs each start's arguments and environment to `<bin>.log`. */
    const logging = (name: string, version: string) => {
      const bin = join(root, name);
      writeFileSync(
        bin,
        `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(`${bin}.log`)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');\n` +
          `if (process.argv[2] === '--version') console.log(${JSON.stringify(version)});\nelse process.exit(3);\n`,
        { mode: 0o755 },
      );
      return bin;
    };
    const logged = (bin: string): { args: string[]; env: NodeJS.ProcessEnv }[] => {
      try {
        return readFileSync(`${bin}.log`, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    const run = async (p: Provider, bin: string, env: NodeJS.ProcessEnv) => {
      const { runners } = await import('../src/server/agents/index');
      return runners[p].run({ ...options(bin), env }).catch((e: unknown) => e);
    };

    it(
      'refuses a run on each CLI too old before it starts, an open agent asked its version in its own home',
      async () => {
        const { openAgents } = await import('../src/server/agents/index');
        const { openHomeEnv } = await import('../src/server/agents/open');
        const { OPEN_AGENT_HOME_ENV } = await import('../src/server/settings');
        for (const p of PROVIDERS) {
          const min = MIN_VERSIONS[p];
          if (!min) continue;
          const bin = logging(`runner-${p}`, '0.0.1');
          // Antigravity's own key: without one it is never started (below).
          const env: NodeJS.ProcessEnv = { ...process.env, [OPEN_AGENT_HOME_ENV]: join(root, 'open-homes', p), GEMINI_API_KEY: 'test-key' };
          const err = await run(p, bin, env);
          expect(err, p).toBeInstanceOf(AgentRunError);
          expect((err as Error).message, p).toBe(t().cliTooOld(PROVIDER_LABEL[p], '0.0.1', min));
          const starts = logged(bin);
          expect(
            starts.map((s) => s.args),
            p,
          ).toEqual([['--version']]);
          if (isOpenProvider(p)) {
            // Not in the user's own home: the variables its home sets, as its status asks it.
            const own = openHomeEnv(openAgents[p].process, env);
            for (const [k, v] of Object.entries(own)) if (env[k] !== v) expect(starts[0]!.env[k], `${p}: ${k}`).toBe(v);
          }
        }
      },
      slow(30_000),
    );

    it('never starts Antigravity without its Gemini API key, not even for its version', async () => {
      const bin = logging('runner-agy-keyless', '0.0.1');
      const err = await run('antigravity', bin, { ...process.env, GEMINI_API_KEY: '' });
      // Whatever its runner says of a run without a key (this one has no more than a program), not that it is too old.
      expect((err as Error).message).not.toBe(t().cliTooOld('Antigravity', '0.0.1', MIN_VERSIONS.antigravity!));
      expect(logged(bin)).toEqual([]);
    });

    it('refuses a run on a program killed as it starts, saying so', async () => {
      const bin = join(root, 'runner-codex-killed');
      writeFileSync(bin, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
      const err = await run('codex', bin, process.env);
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as Error).message).toBe(t().cliKilledAtStart('SIGKILL'));
    });
  });

  describe('a run on a CLI that is too old', () => {
    it('is refused before it starts, saying which version it needs', async () => {
      // As Codex 0.27 does without a terminal, given `app-server`.
      const bin = fake('codex-run-old', 'codex-cli 0.27.0', 'echo "Error: Device not configured (os error 6)" >&2; exit 1');
      let ran = false;
      const runner = newEnoughOnly('codex', () => ({
        provider: 'codex',
        run: async () => {
          ran = true;
          return { text: '', sessionId: '' } as never;
        },
      }));
      const err = await runner.run(options(bin)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as Error).message).toBe(t().cliTooOld('Codex', '0.27.0', MIN_VERSIONS.codex!));
      expect(ran).toBe(false);
      expect(starts(bin)).toEqual(['--version']);
    });

    it('runs as before once it is new enough, or when its version cannot be told', async () => {
      for (const [name, version] of [
        ['codex-run-new', `codex-cli ${CHECKED_VERSIONS.codex}`],
        ['codex-run-unknown', 'codex dev build'],
      ]) {
        const bin = fake(name!, version!);
        const runner = newEnoughOnly('codex', () => ({ provider: 'codex', run: async () => ({ text: 'done', sessionId: 's' }) as never }));
        await expect(runner.run(options(bin))).resolves.toMatchObject({ text: 'done' });
      }
    });
  });
});
