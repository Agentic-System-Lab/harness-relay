/**
 * The CLIs as the specs see them: each one's facts (`clis/<provider>.ts`, one file per CLI, changed
 * with its fake), and what follows from them on this computer: whether a CLI runs below full access
 * here, the permission a test that is not about permissions runs it with, teams for tests of every
 * CLI, and where its fake keeps its home and sessions in a test server.
 */
import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { DEFAULT_MAX_TEAM_AGENTS, isOpenProvider, PROVIDERS, type ConversationSettings, type Mode, type Permission, type Provider } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { openTeamChat, type Member } from './app';
import { FACTS, type CliFacts } from './clis/all';
import type { FakeLogEntry, RelayServer } from './relay';
import { relaySandboxHere } from './sandbox';

export type { CliFacts } from './clis/all';

export interface Cli extends CliFacts {
  /** One of the open agents: no sign-in, it runs on the model backends (`isOpenProvider`). */
  open: boolean;
}

/** A CLI's facts. */
export const cli = (p: Provider): Cli => ({ ...FACTS[p], open: isOpenProvider(p) });

/** All ten CLIs, in Harness Relay's order (`PROVIDERS`). */
export const CLIS: Cli[] = PROVIDERS.map(cli);
/** The five with a sign-in of their own (accounts, API keys): Claude Code, Codex, Grok, Cursor, Antigravity. */
export const SIGNED_IN: Cli[] = CLIS.filter((c) => !c.open);
/** The five open agents: OpenCode, Goose, Cline, OpenHands, Pi. */
export const OPEN: Cli[] = CLIS.filter((c) => c.open);

/** Whether the CLI's fake is written (the others are not installed in a test server by default). */
export const implemented = (p: Provider): boolean => FACTS[p].implemented;

/** The CLIs of `clis` whose fake is written. */
export const faked = (clis: readonly Cli[]): Cli[] => clis.filter((c) => c.implemented);

/**
 * Skips the test (or, called in a `test.describe`, its tests, before any server starts) while the
 * CLI's fake is not written, saying so: its tests run once it is.
 */
export function needsFake(p: Provider): void {
  test.skip(!FACTS[p].implemented, `${FACTS[p].label}'s fake is not written yet (e2e/fake-cli/agents/${p}.cjs)`);
}

/** `body`'s tests once for each of `clis`, each CLI's in a group of its own that is skipped while its fake is not written. */
export function eachCli(clis: readonly Cli[], body: (c: Cli) => void): void {
  for (const c of clis) {
    test.describe(() => {
      needsFake(c.provider);
      body(c);
    });
  }
}

/**
 * The two halves "every CLI" tests run as, a team each (at most `DEFAULT_MAX_TEAM_AGENTS`): the CLIs
 * with a sign-in, which keep the tests' titles of old, and the open agents, whose titles start with
 * `open agents:`.
 */
export const HALVES = [
  { title: (what: string) => what, clis: SIGNED_IN },
  { title: (what: string) => `open agents: ${what}`, clis: OPEN },
] as const;

/** The members of a half's team: its CLIs whose fake is written; the test is skipped when that is fewer than `least`. */
export function teamOf(clis: readonly Cli[], least = 1): Cli[] {
  const team = faked(clis);
  test.skip(team.length < least, `${least === 1 ? 'none' : `fewer than ${least}`} of ${clis.map((c) => c.label).join(', ')} has a fake written yet`);
  return team;
}

/** The facts' defaults, for the facts a CLI's file may leave out (see `CliFacts`). */
export const homeIn = (c: CliFacts): readonly string[] => c.homeIn ?? [];
export const logoutArgs = (c: CliFacts): string => c.logout ?? 'logout';
export const skillReadAsks = (c: CliFacts): boolean => c.skillReadAsks ?? false;
export const showsTodo = (c: CliFacts): boolean => c.todoList ?? true;
/** The tool its `e2e:tool` listing shows as in a chat of `permission`. */
export const listToolAt = (c: CliFacts, permission: Permission): string => (permission === 'full' ? (c.listToolFull ?? c.listTool) : c.listTool);
export const fetchPermission = (c: CliFacts): Permission => c.fetchPermission ?? 'read-only';
export const loggedModel = (c: CliFacts): { model: string; effort: string } => ({
  model: c.pickModel.logged?.model ?? c.pickModel.model,
  effort: c.pickModel.logged?.effort ?? c.pickModel.effort,
});

/** What a reply says of a CLI that ends its turn after a refusal (`decline: 'ends-turn'`). */
export const endsTurnNote = (c: CliFacts): string => `(${c.label} ends its turn after a refusal)`;

/** What a fake writes in a file (`e2e:write`): who wrote it. */
export const writtenBy = (c: CliFacts, name = c.name): string => `Written by ${name} (${c.label}).\n`;

/** What each CLI does with the note the user declines a request with. */
export const DECLINE = Object.fromEntries(PROVIDERS.map((p) => [p, FACTS[p].decline])) as Record<Provider, CliFacts['decline']>;

/** A member of the CLI, by its usual name (`Claude`, `OpenCode`), for `openTeamChat()`. */
export const member = (c: Cli, extra: Partial<Member> = {}): Member => ({ name: c.name, provider: c.provider, ...extra });

/** Whether Harness Relay's own sandbox works here, and why not: global-setup's answer (asked here when there is none). */
export function relaySandbox(): { ok: boolean; reason: string } {
  const said = (process.env.E2E_RELAY_SANDBOX ||= relaySandboxHere());
  return { ok: said === 'ok', reason: said };
}

/** Whether a missing sandbox fails the tests that need it, rather than skipping them (CI: E2E_REQUIRE_RELAY_SANDBOX=1). */
const sandboxRequired = (): boolean => process.env.E2E_REQUIRE_RELAY_SANDBOX === '1';

/**
 * Whether the CLI runs below full access here: on the systems it does (the open agents not on
 * Windows, OpenCode not on Linux), and an open agent only where Harness Relay's own sandbox works,
 * or is required (then its runs fail with the sandbox's own reason).
 */
export function belowFull(p: Provider): boolean {
  const c = FACTS[p];
  if (!c.belowFullOn.includes(process.platform)) return false;
  return c.sandbox !== 'relay' || relaySandbox().ok || sandboxRequired();
}

/** The permission a test that is not about permissions runs the CLI with: `wanted`, or full access where it cannot run below it here. */
export function basePermission(p: Provider, wanted: Permission = 'read-only'): Permission {
  return wanted === 'full' || belowFull(p) ? wanted : 'full';
}

/** The permission one team of `clis` runs with: `wanted`, or full access when one of them cannot run below it here. */
export function sharedPermission(clis: readonly Cli[], wanted: Permission = 'read-only'): Permission {
  return clis.every((c) => basePermission(c.provider, wanted) === wanted) ? wanted : 'full';
}

/**
 * A chat of `members` of the CLIs (`member()` each), at `settings.permission` (default read-only)
 * where each runs below it here, else with full access: for a test that is not about permissions.
 */
export async function chatOf(
  page: Page,
  relay: RelayServer,
  members: { cli: Cli; member?: Partial<Member> }[],
  settings: Partial<ConversationSettings> & { mode?: Mode } = {},
  title?: string,
): Promise<string> {
  const permission = sharedPermission(
    members.map((m) => m.cli),
    settings.permission ?? 'read-only',
  );
  return openTeamChat(page, relay, members.map((m) => member(m.cli, m.member)), { ...settings, permission }, title);
}

/** A chat with the CLI as its one member (its usual name), as `chatOf()`. */
export const chatWith = (page: Page, relay: RelayServer, c: Cli, settings: Partial<ConversationSettings> & { mode?: Mode } = {}): Promise<string> =>
  chatOf(page, relay, [{ cli: c }], settings);

/**
 * The fakes' log entries `match` takes, once there is at least one: a fake in Harness Relay's own
 * sandbox sends its lines over HTTP, which land a moment after its reply.
 */
export async function logged(relay: RelayServer, match: (e: FakeLogEntry) => unknown): Promise<FakeLogEntry[]> {
  await expect.poll(() => relay.fakeLog().filter((e) => match(e)).length, { message: 'the fakes logged what the test looks for' }).toBeGreaterThan(0);
  return relay.fakeLog().filter((e) => match(e));
}

/** Skips the test on a system where the CLI runs with full access only, saying so. */
function onThisSystem(c: CliFacts): void {
  test.skip(!c.belowFullOn.includes(process.platform), `${c.label} runs with full access only on ${process.platform}`);
}

/** Skips the test unless Harness Relay's own sandbox works here; fails it instead when the sandbox is required. */
function withRelaySandbox(): void {
  const s = relaySandbox();
  if (s.ok) return;
  if (sandboxRequired()) throw new Error(`Harness Relay's own sandbox is required (E2E_REQUIRE_RELAY_SANDBOX=1), but it does not work here: ${s.reason}`);
  test.skip(true, `Harness Relay's own sandbox does not work here: ${s.reason}`);
}

/** For a test that needs the CLI below full access (approvals, a read-only chat, a sandbox): skipped where it cannot, saying why. */
export function needsBelowFull(p: Provider): void {
  const c = FACTS[p];
  onThisSystem(c);
  if (c.sandbox === 'relay') withRelaySandbox();
}

/** For a test of Harness Relay's own sandbox around the CLI: skipped where it cannot run in it, failed when the sandbox is required but missing. */
export function needsRelaySandbox(p: Provider): void {
  onThisSystem(FACTS[p]);
  withRelaySandbox();
}

/**
 * Teams for a test of every CLI in `clis`: the CLIs grouped by the permission each runs with here
 * (`basePermission(…, wanted)`), at most `maxTeam` members a team.
 */
export function teams(clis: readonly Cli[], wanted: Permission, maxTeam = DEFAULT_MAX_TEAM_AGENTS): { permission: Permission; members: Cli[] }[] {
  const out: { permission: Permission; members: Cli[] }[] = [];
  for (const c of clis) {
    const permission = basePermission(c.provider, wanted);
    let team = out.findLast((t) => t.permission === permission && t.members.length < maxTeam);
    if (!team) out.push((team = { permission, members: [] }));
    team.members.push(c);
  }
  return out;
}

/** The CLI's default account's home in a test server (`.claude`, `.config/cursor`, `.gemini`, `data/agent-homes/<p>`, …). */
export function defaultHome(relay: RelayServer, p: Provider): string {
  const h = FACTS[p].defaultHome;
  return join(h.in === 'home' ? relay.home : relay.dataDir, ...h.path);
}

/**
 * Where a fake keeps session `id` under `home`: the first file or folder of that name (or the name
 * encoded, as the fakes keep it, or without its dashes, as OpenHands names a session's folder) a walk
 * of `home` finds, at most `depth` folders down, never through a link, or a file whose name ends in
 * `_<id>.jsonl` (Pi's `<time>_<id>.jsonl`). An open agent keeps its sessions in its state folder
 * (`private/<key>/…`).
 */
export function sessionFile(home: string, id: string, depth = 6): string | undefined {
  const names = new Set([id, encodeURIComponent(id), id.replace(/-/g, '').toLowerCase()]);
  const walk = (dir: string, left: number): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const hit = entries.find((e) => names.has(e.name) || (e.isFile() && e.name.endsWith(`_${id}.jsonl`)));
    if (hit) return join(dir, hit.name);
    if (left <= 0) return undefined;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const found = walk(join(dir, e.name), left - 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(home, depth);
}
