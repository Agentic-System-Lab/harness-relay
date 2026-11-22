import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './db';
import {
  HANDOFF_LIMITS,
  SECRET_NAME_RE,
  type CommandProposal,
  type FixedCommand,
  type FixedCommandRun,
  type FolderHandoffs,
} from '../shared/types';
import { secretValueProblem } from '../shared/handoffs';
import { HttpError } from './errors';
import { t } from './i18n';
import type { SecretStore } from './secrets';
import type { Manifest } from './checks';

/*
 * Secrets and fixed commands (docs/architecture.md, "Secrets and fixed commands"), by working directory.
 * A folder's secret values are one entry of the credential store (`SecretStore`: the OS keyring, or
 * encrypted in the database without one), never the database as they are, never the UI, never an agent;
 * their names, the fixed commands and the commands' pins are in `app_settings` (key `handoffs`) as JSON.
 */

/** A fixed command's code as it was when the user saved it (or approved its changes). */
export interface CommandPin {
  /** Its folder's files that are code or configuration (`PIN_PATTERN`), hashed. */
  manifest: Manifest;
  /** The folder's repository, and a snapshot of it kept under `refs/harness-relay/commands/<id>`, for the diff. */
  root?: string;
  commit?: string;
}

interface FolderSaved {
  secrets: Record<string, { setAt: number }>;
  commands: FixedCommand[];
}

interface Saved {
  folders: Record<string, FolderSaved>;
  pins: Record<string, CommandPin>;
}

/** The credential store's entry of a folder's values: by a digest of its path, so the path is not in the store's names. */
export function secretEntry(folder: string): string {
  return `handoffs.${createHash('sha256').update(folder).digest('hex').slice(0, 32)}`;
}

export class HandoffStore {
  private saved: Saved;

  constructor(
    private db: Database,
    private secrets?: SecretStore,
  ) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'handoffs'").get() as { value: string } | undefined;
    let parsed: Partial<Saved> = {};
    try {
      parsed = row ? (JSON.parse(row.value) as Partial<Saved>) : {};
    } catch {
      parsed = {};
    }
    this.saved = {
      folders: parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : {},
      pins: parsed.pins && typeof parsed.pins === 'object' ? parsed.pins : {},
    };
    // A run the server stopped during never finishes: say so.
    for (const f of Object.values(this.saved.folders))
      for (const c of f.commands ?? [])
        if (c.lastRun?.status === 'running') c.lastRun = { ...c.lastRun, status: 'error', reason: undefined };
  }

  private save(): void {
    this.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('handoffs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(this.saved));
  }

  /** Whether secrets can be kept here at all (there is a credential store). */
  get storage(): boolean {
    return Boolean(this.secrets);
  }

  private folder(folder: string, create: true): FolderSaved;
  private folder(folder: string, create?: false): FolderSaved | undefined;
  private folder(folder: string, create = false): FolderSaved | undefined {
    const f = this.saved.folders[folder];
    if (f || !create) return f;
    return (this.saved.folders[folder] = { secrets: {}, commands: [] });
  }

  /** A folder with nothing left goes. */
  private tidy(folder: string): void {
    const f = this.saved.folders[folder];
    if (f && !Object.keys(f.secrets).length && !f.commands.length) delete this.saved.folders[folder];
  }

  /** Every folder with secrets or fixed commands, for Settings: names only. */
  folders(): FolderHandoffs[] {
    return Object.entries(this.saved.folders)
      .map(([folder, f]) => ({ folder, secrets: this.secretNames(folder), commands: f.commands.map((c) => ({ ...c })) }))
      .sort((a, b) => a.folder.localeCompare(b.folder));
  }

  /** The names of a folder's secrets, with when each was set. */
  secretNames(folder: string): { name: string; setAt: number }[] {
    const f = this.folder(folder);
    return f ? Object.entries(f.secrets).map(([name, s]) => ({ name, setAt: s.setAt })) : [];
  }

  has(folder: string, name: string): boolean {
    return Boolean(this.folder(folder)?.secrets[name]);
  }

  /** A folder's values, by name: for the server's own use only (a fixed command's run, masking). */
  values(folder: string): Record<string, string> {
    if (!this.secrets || !this.folder(folder)) return {};
    let raw: string | null;
    try {
      raw = this.secrets.get(secretEntry(folder));
    } catch {
      throw new HttpError(503, t().handoffs.storage);
    }
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  }

  /** Sets (or replaces) some of a folder's secrets: each name and value checked first, none set when one is not valid. */
  setSecrets(folder: string, values: Record<string, string>): void {
    if (!this.secrets) throw new HttpError(503, t().handoffs.storage);
    const entries = Object.entries(values);
    if (!entries.length) throw new HttpError(400, t().invalidField('values'));
    for (const [name, value] of entries) {
      if (!SECRET_NAME_RE.test(name)) throw new HttpError(400, t().handoffs.badName(name));
      const problem = typeof value === 'string' ? secretValueProblem(value) : 'empty';
      if (problem) throw new HttpError(400, t().handoffs.badValue(name, problem));
    }
    const current = this.values(folder);
    const next = { ...current, ...Object.fromEntries(entries.map(([n, v]) => [n, v.trim()])) };
    if (Object.keys(next).length > HANDOFF_LIMITS.secretsPerFolder) {
      throw new HttpError(400, t().handoffs.tooManySecrets(HANDOFF_LIMITS.secretsPerFolder));
    }
    try {
      this.secrets.set(secretEntry(folder), JSON.stringify(next));
    } catch {
      throw new HttpError(503, t().handoffs.storage);
    }
    const f = this.folder(folder, true);
    const now = Date.now();
    for (const [name] of entries) f.secrets[name] = { setAt: now };
    this.save();
  }

  deleteSecret(folder: string, name: string): void {
    const f = this.folder(folder);
    if (!f?.secrets[name]) throw new HttpError(404, t().handoffs.secretNotFound(name));
    const rest = this.values(folder);
    delete rest[name];
    try {
      if (Object.keys(rest).length) this.secrets?.set(secretEntry(folder), JSON.stringify(rest));
      else this.secrets?.delete(secretEntry(folder));
    } catch {
      throw new HttpError(503, t().handoffs.storage);
    }
    delete f.secrets[name];
    this.tidy(folder);
    this.save();
  }

  commands(folder: string): FixedCommand[] {
    return this.folder(folder)?.commands.map((c) => ({ ...c })) ?? [];
  }

  command(id: string): FixedCommand | undefined {
    for (const f of Object.values(this.saved.folders)) {
      const c = f.commands.find((x) => x.id === id);
      if (c) return { ...c };
    }
    return undefined;
  }

  commandByName(folder: string, name: string): FixedCommand | undefined {
    const c = this.folder(folder)?.commands.find((x) => x.name === name);
    return c ? { ...c } : undefined;
  }

  /**
   * The id a proposal saved in this folder gets: its saved namesake's (which it replaces, so schedules
   * and outbox runs naming it still do), or a new one; with whether there is room for it.
   */
  commandId(folder: string, name: string): string {
    const f = this.folder(folder);
    const same = f?.commands.find((c) => c.name === name);
    if (same) return same.id;
    if ((f?.commands.length ?? 0) >= HANDOFF_LIMITS.commandsPerFolder) {
      throw new HttpError(400, t().handoffs.tooManyCommands(HANDOFF_LIMITS.commandsPerFolder));
    }
    return randomUUID();
  }

  /** Saves a proposal as the folder's fixed command `id` (`commandId()`), pinned: a saved one of the same name is replaced. */
  saveCommand(folder: string, id: string, proposal: CommandProposal, pin: CommandPin): FixedCommand {
    const f = this.folder(folder, true);
    const now = Date.now();
    const same = f.commands.find((c) => c.id === id || c.name === proposal.name);
    if (!same && f.commands.length >= HANDOFF_LIMITS.commandsPerFolder) {
      throw new HttpError(400, t().handoffs.tooManyCommands(HANDOFF_LIMITS.commandsPerFolder));
    }
    const command: FixedCommand = { ...proposal, id, folder, createdAt: same?.createdAt ?? now, pinnedAt: now };
    if (same) f.commands[f.commands.indexOf(same)] = command;
    else f.commands.push(command);
    this.saved.pins[id] = pin;
    this.save();
    return { ...command };
  }

  pin(id: string): CommandPin | undefined {
    return this.saved.pins[id];
  }

  /** A command's code pinned again (the user approved its changes): returns the pin it replaced. */
  repin(id: string, pin: CommandPin): CommandPin | undefined {
    const c = this.find(id);
    if (!c) throw new HttpError(404, t().handoffs.commandNotFound);
    const old = this.saved.pins[id];
    this.saved.pins[id] = pin;
    c.pinnedAt = Date.now();
    this.save();
    return old;
  }

  setLastRun(id: string, run: FixedCommandRun): void {
    const c = this.find(id);
    if (!c) return;
    c.lastRun = run;
    this.save();
  }

  /** Removes a command: returns it with its pin (whose kept snapshot the caller drops). */
  deleteCommand(id: string): { command: FixedCommand; pin?: CommandPin } {
    for (const [folder, f] of Object.entries(this.saved.folders)) {
      const i = f.commands.findIndex((c) => c.id === id);
      if (i < 0) continue;
      const [command] = f.commands.splice(i, 1);
      const pin = this.saved.pins[id];
      delete this.saved.pins[id];
      this.tidy(folder);
      this.save();
      return { command: command!, ...(pin ? { pin } : {}) };
    }
    throw new HttpError(404, t().handoffs.commandNotFound);
  }

  private find(id: string): FixedCommand | undefined {
    for (const f of Object.values(this.saved.folders)) {
      const c = f.commands.find((x) => x.id === id);
      if (c) return c;
    }
    return undefined;
  }
}
