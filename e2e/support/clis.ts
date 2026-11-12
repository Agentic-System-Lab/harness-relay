/**
 * The CLIs as the specs see them: each one's facts (`clis/<provider>.ts`, one file per CLI, changed
 * with its fake), and what follows from them on this computer: whether a CLI runs below full access
 * here, the permission a test that is not about permissions runs it with, teams for tests of every
 * CLI, and where its fake keeps its home and sessions in a test server.
 */
import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { DEFAULT_MAX_TEAM_AGENTS, isOpenProvider, PROVIDERS, type Permission, type Provider } from '../../src/shared/types';
import type { Member } from './app';
import { FACTS, type CliFacts } from './clis/all';
import type { RelayServer } from './relay';
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
 * encoded, as the fakes keep it) a walk of `home` finds, at most `depth` folders down, never through
 * a link. An open agent keeps its sessions in its state folder (`private/<key>/…`).
 */
export function sessionFile(home: string, id: string, depth = 6): string | undefined {
  const names = new Set([id, encodeURIComponent(id)]);
  const walk = (dir: string, left: number): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const hit = entries.find((e) => names.has(e.name));
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
