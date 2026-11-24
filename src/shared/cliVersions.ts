import type { Provider } from './types';

/**
 * The version of each agent CLI that Harness Relay was last checked with, end to end, against the
 * real CLI (docs/sandboxing.md, "What was tested", has the systems and dates). The one place it is written:
 * Settings installs the open agents' versions from it (`CLI_RECIPES` in `src/server/cliInstall.ts`),
 * the user guide's list of CLIs says the same (`test/cli-check.test.ts` holds them equal), and
 * `scripts/cli-check.ts` compares it with what each maker has published since.
 *
 * Move a version forward only once `npx tsx scripts/cli-check.ts <cli>` passes for the new one and
 * what it reported was looked at (docs/developer-guide.md, "Checking a CLI's new version"), in the
 * same commit as the shapes it saved (`--accept`) and the user guide's lines.
 */
export const CHECKED_VERSIONS: Record<Provider, string> = {
  claude: '2.1.322',
  codex: '0.167.0',
  grok: '1.0.77',
  cursor: '2026.11.11-043ef28',
  antigravity: '1.5.6',
  copilot: '1.0.109',
  muse: '1.4.18',
  opencode: '1.19.5',
  goose: '1.58.1',
  cline: '3.0.74',
  openhands: '1.16.0',
  pi: '1.5.1',
};

/**
 * The oldest version of each CLI that has everything Harness Relay starts it with and relies on: its
 * subcommands, the flags that decide how it runs, and the settings that keep it in its sandbox.
 * Harness Relay starts its CLIs without a terminal, and an older one takes a subcommand it does not
 * know for a prompt: Codex 0.27 then opens its terminal UI and fails ("Device not configured (os error
 * 6)"), Claude Code 2.1.39 and older send `auth status` to the model, Antigravity before 1.1.11 its
 * `/skills`. A CLI older than this is not started at all (`src/server/cliVersion.ts`): Settings says it
 * is too old and offers to install a current one. A CLI without an entry is started whatever its
 * version. Each was found by running old builds where they can be had (2026-11-24), else from the
 * maker's release notes:
 *
 * - Codex 0.133.0: from it, runs (with their permission profiles, which 0.105 to 0.132 refuse to load),
 *   what it loads, plan usage and sign-ins work; team hooks need a newer one (0.166 lists them for a
 *   thread), and a turn that has them says so itself (`codexHooksUnchecked`, which names 0.167.0). `app-server` is 0.43's: before it, Codex opens its terminal UI and fails.
 *   On macOS 0.47 to 0.130 are killed as they start (a revoked signature), before saying their version.
 * - Claude Code 2.1.83: `sandbox.failIfUnavailable`, without which 2.1.79 to 2.1.82 run commands
 *   unsandboxed where the sandbox cannot start (`auth login --console` is 2.1.79's; `auth` is in 2.1.40's program, its changelog says 2.1.41).
 * - Grok 1.0.0: the oldest build there is, which has `agent --no-leader stdio`, `models`, `inspect`
 *   and its sign-ins.
 * - Cursor 2026.05.15: `--disable-project-configs` before `acp` (`status`/`about --format json` are
 *   2026.04.13's); an older one refuses the flag.
 * - Antigravity 1.5.0: `acp` (`plugin list --json` is 1.3.4's; `-p /skills` answered without the
 *   model 1.1.11's).
 * - Copilot 1.0.103: its ACP sessions apply `--sandbox` (before, `/sandbox policy` says sandboxing is
 *   off, and every run below full access is refused); `instruction|plugin list --json` are 1.0.84's,
 *   ACP `logout` 1.0.98's.
 * - Muse Code 1.4.18: the oldest build whose answers were recorded; no older build or release notes
 *   could be had, and an older one would take `usage` (asked at every status check) for a prompt.
 * - The open agents, which Settings installs at the versions checked, but which can be the user's own:
 *   OpenCode 1.4.8 (the last of the variables that keep it in its own home and out of the project's
 *   configuration, which an older one ignores without a word), Goose 1.38.0 (`system-prompt/set` and
 *   `session/steer`), Cline 3.0.0 (its ACP as Harness Relay drives it), OpenHands 1.12.0 (its folders'
 *   variables), Pi 1.0.4 (`--no-mcp`; an older one refuses the flags it does not know).
 *
 * Raise a CLI's entry when Harness Relay comes to start it with something its entry's version does not
 * have yet (docs/developer-guide.md, "Checking a CLI's new version").
 */
export const MIN_VERSIONS: Partial<Record<Provider, string>> = {
  claude: '2.1.83',
  codex: '0.133.0',
  grok: '1.0.0',
  cursor: '2026.05.15',
  antigravity: '1.5.0',
  copilot: '1.0.103',
  muse: '1.4.18',
  opencode: '1.4.8',
  goose: '1.38.0',
  cline: '3.0.0',
  openhands: '1.12.0',
  pi: '1.0.4',
};

/** A version's numbers (`0.167.0`, `2026.11.11-043ef28`, `1.4.18 (1.4.18-R8587.1)`): its first dotted run of them. */
function versionNumbers(v: string): number[] | undefined {
  const m = v.match(/\d+(?:\.\d+)*/);
  return m ? m[0].split('.').map(Number) : undefined;
}

/**
 * Whether version `a` comes before `b`, by their numbers alone (a suffix such as `-043ef28` or a
 * pre-release's is not compared); undefined when either has none.
 */
export function versionBefore(a: string, b: string): boolean | undefined {
  const x = versionNumbers(a);
  const y = versionNumbers(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** The version a CLI needs when `version` is older than its minimum (`MIN_VERSIONS`); undefined when it is new enough or cannot be told. */
export function tooOldFor(p: Provider, version: string | undefined): string | undefined {
  const min = MIN_VERSIONS[p];
  return min && version && versionBefore(version, min) === true ? min : undefined;
}
