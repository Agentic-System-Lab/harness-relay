import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { t } from './i18n';

/*
 * Grok reads a project's own instructions, skills, MCP servers and hooks only in a folder the user
 * trusted. The Grok that Harness Relay starts (`grok agent stdio`) cannot be told to trust one, so
 * when the user asks for it (and confirms), Harness Relay records the same entry `grok --trust`
 * does, in Grok's folder-trust store: `$GROK_HOME/trusted_folders.toml`.
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

/** Records `folder` as trusted in Grok's trust store (written whole, owner-only, like Grok keeps it). */
export function trustGrokFolder(folder: string, env: NodeJS.ProcessEnv, now = Date.now()): void {
  const file = join(grokHome(env), 'trusted_folders.toml');
  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.relay-${process.pid}`;
    writeFileSync(tmp, withTrustedFolder(existing, folder, Math.floor(now / 1000)), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    throw new Error(t().grokTrustFailed((err as Error).message));
  }
}
