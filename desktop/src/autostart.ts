/**
 * "Open at login" on Linux. Electron's login items work on macOS and Windows only, so on Linux the
 * app writes an XDG autostart entry itself (~/.config/autostart/harness-relay.desktop), which GNOME,
 * KDE and the other desktops start at login.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Characters that make an argument of `Exec` need quotes (Desktop Entry Specification). */
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

/** One argument of an `Exec` line. */
export function execArg(arg: string): string {
  // `%` starts a field code; a literal one is written twice.
  const value = arg.replace(/%/g, '%%');
  if (!RESERVED.test(value) && value !== '') return value;
  return `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** The `Exec` value: the quoted arguments, with the backslash escaping every string value gets on top. */
export function execLine(args: string[]): string {
  return args.map(execArg).join(' ').replace(/\\/g, '\\\\');
}

/** The autostart entry that starts `exec` (the program and its arguments) at login. */
export function desktopEntry(o: { name: string; comment: string; exec: string[] }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${clean(o.name)}`,
    `Comment=${clean(o.comment)}`,
    `Exec=${execLine(o.exec)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** Where the entry goes: $XDG_CONFIG_HOME/autostart, or ~/.config/autostart. */
export function autostartFile(env: NodeJS.ProcessEnv, home: string): string {
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return join(config, 'autostart', 'harness-relay.desktop');
}

export function isAutostartOn(file: string): boolean {
  return existsSync(file);
}

export function setAutostart(file: string, on: boolean, entry: string): void {
  if (!on) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, entry, { mode: 0o644 });
}
