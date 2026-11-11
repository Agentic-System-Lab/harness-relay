import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeGrokSetting } from './agents/grok';
import { t } from './i18n';

/*
 * Grok reads a project's own instructions, skills, MCP servers and hooks only in a folder the user
 * trusted. The Grok that Harness Relay starts (`grok agent stdio`) cannot be told to trust one, so
 * when the user asks for it (and confirms), Harness Relay records the same entry `grok --trust`
 * does, in Grok's folder-trust store: `$GROK_HOME/trusted_folders.toml`. Grok keys trust on the
 * project root (the repository root, links resolved), which `grok inspect` reports: that folder is
 * the one recorded (`NativeSetup.trustFolder`), not the working directory as typed.
 */

/** Grok's config folder: `GROK_HOME`, else `~/.grok`. */
export function grokHome(env: NodeJS.ProcessEnv): string {
  return env.GROK_HOME || join(homedir(), '.grok');
}

/** A TOML basic string (a path, possibly with backslashes or quotes). */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

/**
 * The trust store with `folder` trusted: its table is replaced when there is one (a folder marked
 * untrusted), else added at the end. Everything else in the file is kept as it is.
 */
export function withTrustedFolder(existing: string, folder: string, decidedAt: number): string {
  const header = `[folders.${tomlString(folder)}]`;
  const entry = `${header}\ntrusted = true\ndecided_at = ${decidedAt}\n`;
  const lines = existing.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) {
    const base = existing.replace(/\s*$/, '');
    return base ? `${base}\n\n${entry}` : entry;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trim().startsWith('[')) end++;
  const rest = lines.slice(end).join('\n').replace(/^\s*/, '');
  const before = lines.slice(0, start).join('\n').replace(/\s*$/, '');
  return [before, entry.trimEnd(), rest.trimEnd()].filter(Boolean).join('\n\n') + '\n';
}

const storeFile = (env: NodeJS.ProcessEnv) => join(grokHome(env), 'trusted_folders.toml');

/**
 * Writes the trust store whole, owner-only, like Grok keeps it. The file beside it has a name no one
 * can guess and must be new (`wx`): a sandboxed command can write in Grok's home, and a link left
 * there under a known name would have the store written wherever it leads.
 */
function writeStore(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.relay-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Records `folder` as trusted in Grok's trust store. Returns what the store held before (null: no
 * store yet), for `restoreGrokTrust` when Grok does not take the entry.
 */
export function trustGrokFolder(folder: string, env: NodeJS.ProcessEnv, now = Date.now()): string | null {
  const file = storeFile(env);
  try {
    let existing: string | null = null;
    // Grok turns running now check its settings when they end: this change is Harness Relay's own,
    // made to the store as they found it, not as their commands may have changed it.
    writeGrokSetting(grokHome(env), 'trusted_folders.toml', () => {
      existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
      const text = withTrustedFolder(existing ?? '', folder, Math.floor(now / 1000));
      writeStore(file, text);
      return text;
    });
    return existing;
  } catch (err) {
    throw new Error(t().grokTrustFailed((err as Error).message));
  }
}

/** Puts back the trust store as `trustGrokFolder` found it (null: there was none). */
export function restoreGrokTrust(previous: string | null, env: NodeJS.ProcessEnv): void {
  const file = storeFile(env);
  writeGrokSetting(grokHome(env), 'trusted_folders.toml', () => {
    if (previous === null) rmSync(file, { force: true });
    else writeStore(file, previous);
    return previous;
  });
}

/** One Grok home's trust store as `trustGrokFolder` found it, to put back. */
export interface GrokTrustWrite {
  env: NodeJS.ProcessEnv;
  previous: string | null;
}

/**
 * Records `folder` as trusted in each Grok home given (every Grok account's), all or none: when one
 * cannot be written, those written already are put back and the error is thrown.
 */
export function trustGrokFolderAll(folder: string, envs: NodeJS.ProcessEnv[], now = Date.now()): GrokTrustWrite[] {
  const done: GrokTrustWrite[] = [];
  try {
    for (const env of envs) done.push({ env, previous: trustGrokFolder(folder, env, now) });
  } catch (err) {
    restoreGrokTrustAll(done);
    throw err;
  }
  return done;
}

/** Puts back every trust store `trustGrokFolderAll` wrote; one that cannot be put back is logged. */
export function restoreGrokTrustAll(writes: GrokTrustWrite[]): void {
  for (const { env, previous } of writes) {
    try {
      restoreGrokTrust(previous, env);
    } catch (err) {
      console.warn(`[grok] could not put back the trust store in ${grokHome(env)}: ${(err as Error).message}`);
    }
  }
}

/**
 * Gives a new Grok account the default account's trust: its trust store copied into the new home,
 * so a folder Settings shows as trusted (asked of the default account) is trusted for it too. Only a
 * plain file is copied, never what a link there leads to.
 */
export function copyGrokTrust(from: NodeJS.ProcessEnv, to: NodeJS.ProcessEnv): void {
  const source = storeFile(from);
  if (!existsSync(source) || !lstatSync(source).isFile()) return;
  const text = readFileSync(source, 'utf8');
  writeGrokSetting(grokHome(to), 'trusted_folders.toml', () => {
    writeStore(storeFile(to), text);
    return text;
  });
}
