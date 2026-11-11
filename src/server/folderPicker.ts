// The system's own folder dialog, opened on this computer for the working directory box's button:
// AppleScript's `choose folder` on macOS, zenity or kdialog on Linux, Windows Forms' folder browser on
// Windows. Which program to run and how to read its answer are pure functions, tested without a dialog.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { runProcess, runShellScript, tail, type RunOptions, type SpawnResult } from './process';
import { findOnPath } from './voice';

export type PickerKind = 'osascript' | 'zenity' | 'kdialog' | 'powershell';

/** How long a dialog may stay open before it is closed as if cancelled. */
export const PICK_TIMEOUT_MS = 10 * 60_000;

/**
 * The dialog's script: several folders may be chosen, one path to a line; Cancel answers nothing. The
 * title and the folder it opens at come as the run handler's arguments, read as strings, never as
 * code. The dialog is a modal panel, which shows above the browser's windows by itself. No `activate`:
 * making osascript the active app took about two of the three seconds the dialog took to show (macOS
 * 26), and macOS no longer lets a program started in the background take the focus anyway.
 */
const APPLESCRIPT = [
  'on run argv',
  'try',
  'set chosen to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)) with multiple selections allowed',
  'on error number -128',
  'return ""',
  'end try',
  'set out to ""',
  'repeat with f in chosen',
  'set out to out & POSIX path of f & linefeed',
  'end repeat',
  'return out',
  'end run',
];

/**
 * Windows' dialog, fixed text: the title and the folder it opens at come in the environment. It
 * belongs to an invisible window that stays on top, so it opens in front of the browser; that
 * window is shown first, so a hidden start (the server starts its children without a window) is
 * spent on it rather than on the dialog. Cancel writes nothing.
 */
const POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.Opacity = 0',
  "$owner.FormBorderStyle = 'None'",
  '$owner.Show()',
  '$owner.Activate()',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = $env:RELAY_PICK_TITLE',
  '$dialog.ShowNewFolderButton = $true',
  '$dialog.SelectedPath = $env:RELAY_PICK_START',
  'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
  '$owner.Close()',
].join('\n');

/** Windows PowerShell's flags before the script; `-STA` for the Forms dialog. */
const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass'] as const;

/**
 * The dialog this computer has: always on macOS and Windows; on Linux and the like, zenity (GNOME and
 * most others) or else kdialog (KDE) on the PATH, in a graphical session. `undefined`: none.
 */
export function pickerKind(
  platform: string,
  env: NodeJS.ProcessEnv,
  isFile?: (path: string) => boolean,
): { kind: PickerKind; bin: string } | undefined {
  if (platform === 'darwin') return { kind: 'osascript', bin: '/usr/bin/osascript' };
  if (platform === 'win32') return { kind: 'powershell', bin: 'powershell.exe' };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined;
  for (const kind of ['zenity', 'kdialog'] as const) {
    const bin = findOnPath(kind, env, platform, [], isFile);
    if (bin) return { kind, bin };
  }
  return undefined;
}

/** What to run: a program with its arguments, or (PowerShell) a fixed script with its values in `env`. */
export type PickerCommand =
  | { bin: string; args: string[]; env: NodeJS.ProcessEnv }
  | { shell: string; flags: readonly string[]; script: string; env: NodeJS.ProcessEnv };

/** The command that opens the dialog titled `title` at the folder `start` (which exists). */
export function pickerCommand(kind: PickerKind, bin: string, title: string, start: string, env: NodeJS.ProcessEnv): PickerCommand {
  switch (kind) {
    case 'osascript':
      return { bin, args: [...APPLESCRIPT.flatMap((line) => ['-e', line]), title, start], env };
    case 'zenity':
      // Several folders, one to a line. A separator at the end opens the dialog inside the folder
      // rather than beside it.
      return {
        bin,
        args: ['--file-selection', '--directory', '--multiple', '--separator=\n', `--title=${title}`, `--filename=${start.replace(/\/*$/, '/')}`],
        env,
      };
    case 'kdialog':
      return { bin, args: ['--title', title, '--getexistingdirectory', start], env };
    case 'powershell':
      return { shell: bin, flags: POWERSHELL_FLAGS, script: POWERSHELL, env: { ...env, RELAY_PICK_TITLE: title, RELAY_PICK_START: start } };
  }
}

/**
 * The folders the dialog answered, one to a line (kdialog and Windows' dialog answer one); none when
 * it was cancelled or closed (also when its program was stopped: by the request, its time limit, or a
 * signal from elsewhere). zenity and kdialog say Cancel by exiting with 1; the scripts above answer
 * nothing. AppleScript ends a folder's path with `/`, left out here but for the root's. Only line
 * breaks are taken off: a folder's name may end with a space (one with a line break in its name
 * cannot be told apart). Anything else is an error, with what the program said.
 */
export function pickedFolders(kind: PickerKind, r: Pick<SpawnResult, 'code' | 'stdout' | 'stderr' | 'aborted' | 'timedOut'>): string[] {
  if (r.aborted || r.timedOut || r.code === null) return [];
  if (r.code === 1 && (kind === 'zenity' || kind === 'kdialog')) return [];
  if (r.code !== 0) throw new Error(tail(r.stderr.trim(), 300) || `exit code ${r.code}`);
  const lines = r.stdout.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  return kind === 'osascript' ? lines.map((p) => (p.length > 1 ? p.replace(/\/$/, '') : p)) : lines;
}

/** The nearest folder that exists, from `path` (absolute) up; the home folder when none does (a drive that is gone). */
export function existingFolder(path: string): string {
  let dir = path;
  for (;;) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    } catch {
      /* unreadable: look further up */
    }
    const up = dirname(dir);
    if (up === dir) return homedir();
    dir = up;
  }
}

/** Opens the folder dialog on this computer. */
export interface FolderPicker {
  /** Whether this computer has a folder dialog to open. */
  available(): boolean;
  /** Opens it, titled `title`, at `start` (a folder that exists): the folders chosen, none when cancelled. */
  pick(o: { title: string; start: string; signal?: AbortSignal }): Promise<string[]>;
}

/** The system's own dialog, through `src/server/process.ts` (`run` stands in for it in tests). */
export function systemFolderPicker(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: { process: typeof runProcess; script: typeof runShellScript } = { process: runProcess, script: runShellScript },
): FolderPicker {
  return {
    available: () => pickerKind(platform, env) !== undefined,
    async pick({ title, start, signal }) {
      const found = pickerKind(platform, env);
      if (!found) throw new Error('No folder dialog on this computer');
      const cmd = pickerCommand(found.kind, found.bin, title, start, { ...env });
      const opts: RunOptions = { env: cmd.env, signal, timeoutMs: PICK_TIMEOUT_MS };
      const r = 'shell' in cmd ? await run.script(cmd.shell, cmd.flags, cmd.script, opts) : await run.process({ ...opts, bin: cmd.bin, args: cmd.args });
      return pickedFolders(found.kind, r);
    },
  };
}
