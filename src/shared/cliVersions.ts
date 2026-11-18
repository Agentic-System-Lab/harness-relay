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
