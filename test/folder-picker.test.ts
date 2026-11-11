import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PICK_TIMEOUT_MS,
  existingFolder,
  pickedFolders,
  pickerCommand,
  pickerKind,
  systemFolderPicker,
} from '../src/server/folderPicker';
import type { RunOptions, SpawnOptions, SpawnResult } from '../src/server/process';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-picker-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const result = (r: Partial<SpawnResult>) => ({ code: 0, stdout: '', stderr: '', aborted: false, timedOut: false, ...r });

describe('pickerKind', () => {
  it('uses AppleScript on macOS and PowerShell on Windows', () => {
    expect(pickerKind('darwin', {})).toEqual({ kind: 'osascript', bin: '/usr/bin/osascript' });
    expect(pickerKind('win32', { SystemRoot: 'D:\\Windows' })).toEqual({
      kind: 'powershell',
      bin: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
    expect(pickerKind('win32', {})?.bin).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('uses zenity, else kdialog, on the PATH of a graphical session elsewhere', () => {
    const on = (...files: string[]) => (p: string) => files.includes(p);
    const env = { PATH: '/usr/local/bin:/usr/bin', DISPLAY: ':0' };
    expect(pickerKind('linux', env, on('/usr/bin/zenity', '/usr/bin/kdialog'))).toEqual({ kind: 'zenity', bin: '/usr/bin/zenity' });
    expect(pickerKind('linux', env, on('/usr/local/bin/kdialog'))).toEqual({ kind: 'kdialog', bin: '/usr/local/bin/kdialog' });
    expect(pickerKind('linux', { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0' }, on('/usr/bin/zenity'))?.kind).toBe('zenity');
    expect(pickerKind('linux', env, on())).toBeUndefined();
  });

  it('has none without a graphical session (over ssh, say)', () => {
    expect(pickerKind('linux', { PATH: '/usr/bin' }, () => true)).toBeUndefined();
  });
});

describe('pickerCommand', () => {
  it('passes AppleScript the title and the folder as arguments, after the fixed script', () => {
    const cmd = pickerCommand('osascript', '/usr/bin/osascript', '選擇工作目錄', '/Users/me/my "work"', { HOME: '/Users/me' });
    if (!('bin' in cmd)) throw new Error('not a program');
    expect(cmd.bin).toBe('/usr/bin/osascript');
    expect(cmd.args.slice(-2)).toEqual(['選擇工作目錄', '/Users/me/my "work"']);
    // Every line of the script is an -e of its own, and none of them holds a value.
    const script = cmd.args.slice(0, -2);
    expect(script.filter((_, i) => i % 2 === 0).every((a) => a === '-e')).toBe(true);
    expect(script.join('\n')).not.toMatch(/選擇|work/);
    // Not `activate`: it made the dialog show seconds later.
    expect(script).not.toContain('activate');
    expect(script.join('\n')).toContain('with multiple selections allowed');
    expect(cmd.env).toEqual({ HOME: '/Users/me' });
  });

  it('gives zenity and kdialog a UTF-8 character set when the environment has none, for a title in Chinese', () => {
    // No locale (a server a service started): zenity refuses a Chinese title without one.
    expect(pickerCommand('zenity', '/usr/bin/zenity', '選擇工作目錄', '/home/me', { PATH: '/usr/bin' }).env).toEqual({ PATH: '/usr/bin', LC_CTYPE: 'C.UTF-8' });
    expect(pickerCommand('kdialog', '/usr/bin/kdialog', '選擇工作目錄', '/home/me', { LANG: 'C' }).env).toEqual({ LANG: 'C', LC_CTYPE: 'C.UTF-8' });
    // One there already is kept, whichever variable names it.
    for (const env of [{ LANG: 'zh_TW.UTF-8' }, { LANG: 'C', LC_CTYPE: 'en_US.utf8' }, { LC_ALL: 'C.UTF-8' }]) {
      expect(pickerCommand('zenity', '/usr/bin/zenity', 'T', '/', env).env).toEqual(env);
    }
    // LC_ALL wins over LC_CTYPE: it is the one changed.
    expect(pickerCommand('zenity', '/usr/bin/zenity', 'T', '/', { LC_ALL: 'C', LANG: 'zh_TW.UTF-8' }).env).toEqual({ LC_ALL: 'C.UTF-8', LANG: 'zh_TW.UTF-8' });
  });

  it('opens zenity inside the folder, for several folders one to a line, and kdialog at it', () => {
    expect(pickerCommand('zenity', '/usr/bin/zenity', 'Choose', '/home/me/work', {})).toMatchObject({
      bin: '/usr/bin/zenity',
      args: ['--file-selection', '--directory', '--multiple', '--separator=\n', '--title=Choose', '--filename=/home/me/work/'],
    });
    expect(pickerCommand('zenity', '/usr/bin/zenity', 'Choose', '/', {})).toMatchObject({ args: expect.arrayContaining(['--filename=/']) });
    expect(pickerCommand('kdialog', '/usr/bin/kdialog', 'Choose', '/home/me/work', {})).toMatchObject({
      args: ['--title', 'Choose', '--getexistingdirectory', '/home/me/work'],
    });
  });

  it('gives Windows PowerShell a fixed script, the title and the folder in its environment', () => {
    const cmd = pickerCommand('powershell', 'powershell.exe', 'Choose', 'C:\\Users\\me\\work', { Path: 'C:\\Windows' });
    if (!('shell' in cmd)) throw new Error('not a script');
    expect(cmd.shell).toBe('powershell.exe');
    expect(cmd.flags).toContain('-STA');
    expect(cmd.flags).toContain('-NoProfile');
    expect(cmd.env).toEqual({ Path: 'C:\\Windows', RELAY_PICK_TITLE: 'Choose', RELAY_PICK_START: 'C:\\Users\\me\\work' });
    expect(cmd.script).toContain('$env:RELAY_PICK_TITLE');
    expect(cmd.script).toContain('$env:RELAY_PICK_START');
    expect(cmd.script).not.toContain('Users');
    // It goes on the command line as one argument: no double quotes for Windows to take apart.
    expect(cmd.script).not.toContain('"');
    expect(pickerCommand('powershell', 'powershell.exe', 'Other', 'D:\\', {})).toMatchObject({ script: cmd.script });
  });
});

describe('pickedFolders', () => {
  it('reads one folder to a line, without the separator AppleScript ends each with', () => {
    expect(pickedFolders('osascript', result({ stdout: '/Users/me/My Project/\n/Users/me/工作/\n' }))).toEqual(['/Users/me/My Project', '/Users/me/工作']);
    expect(pickedFolders('osascript', result({ stdout: '/\n' }))).toEqual(['/']);
    expect(pickedFolders('zenity', result({ stdout: '/home/me/trailing space \n/home/me/b\n' }))).toEqual(['/home/me/trailing space ', '/home/me/b']);
    expect(pickedFolders('kdialog', result({ stdout: '/home/me/工作\n' }))).toEqual(['/home/me/工作']);
    expect(pickedFolders('powershell', result({ stdout: '\uFEFFC:\\Users\\me\\work' }))).toEqual(['C:\\Users\\me\\work']);
    expect(pickedFolders('powershell', result({ stdout: 'D:\\\r\n' }))).toEqual(['D:\\']);
  });

  it('is none when the dialog was cancelled, timed out or stopped', () => {
    expect(pickedFolders('osascript', result({ stdout: '\n' }))).toEqual([]);
    expect(pickedFolders('osascript', result({ stdout: '' }))).toEqual([]);
    expect(pickedFolders('powershell', result({ stdout: '' }))).toEqual([]);
    expect(pickedFolders('zenity', result({ code: 1 }))).toEqual([]);
    expect(pickedFolders('kdialog', result({ code: 1 }))).toEqual([]);
    expect(pickedFolders('osascript', result({ code: null, aborted: true }))).toEqual([]);
    expect(pickedFolders('zenity', result({ code: null, timedOut: true }))).toEqual([]);
    expect(pickedFolders('osascript', result({ code: null }))).toEqual([]); // killed from elsewhere
  });

  it('is an error, with what the program said, when it failed', () => {
    expect(() => pickedFolders('osascript', result({ code: 1, stderr: 'execution error: No user interaction allowed. (-1713)\n' }))).toThrow(
      'execution error: No user interaction allowed. (-1713)',
    );
    expect(() => pickedFolders('zenity', result({ code: 255, stderr: '' }))).toThrow('exit code 255');
  });
});

describe('existingFolder', () => {
  it('is the folder itself, or the nearest one above it that exists', () => {
    const dir = join(root, 'a b');
    mkdirSync(dir);
    expect(existingFolder(dir)).toBe(dir);
    expect(existingFolder(join(dir, 'not', 'yet'))).toBe(dir);
  });

  it('is the folder a file is in', () => {
    const file = join(root, 'notes.txt');
    writeFileSync(file, 'x');
    expect(existingFolder(file)).toBe(root);
    expect(existingFolder(join(file, 'below'))).toBe(root);
  });
});

describe('systemFolderPicker', () => {
  function fakeRun(answer: Partial<SpawnResult>) {
    const calls: { process?: SpawnOptions; script?: { shell: string; flags: readonly string[]; script: string; o: RunOptions } }[] = [];
    const done = (r: Partial<SpawnResult>): SpawnResult => ({
      signal: null,
      stdoutBytes: Buffer.from(r.stdout ?? ''),
      stdoutTruncated: false,
      stdoutSize: 0,
      ...result(r),
    });
    return {
      calls,
      run: {
        process: async (o: SpawnOptions) => (calls.push({ process: o }), done(answer)),
        script: async (shell: string, flags: readonly string[], script: string, o: RunOptions) => (calls.push({ script: { shell, flags, script, o } }), done(answer)),
      },
    };
  }

  it('runs the dialog with a time limit and the request’s signal, and answers the folder chosen', async () => {
    const { calls, run } = fakeRun({ stdout: '/Users/me/work/\n' });
    const picker = systemFolderPicker('darwin', { HOME: '/Users/me' }, run);
    expect(picker.available()).toBe(true);
    const signal = new AbortController().signal;
    expect(await picker.pick({ title: 'Choose', start: '/Users/me', signal })).toEqual(['/Users/me/work']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.process).toMatchObject({ bin: '/usr/bin/osascript', env: { HOME: '/Users/me' }, signal, timeoutMs: PICK_TIMEOUT_MS });
    expect(calls[0]!.process!.args.slice(-2)).toEqual(['Choose', '/Users/me']);
  });

  it('runs Windows’ dialog as a script', async () => {
    const { calls, run } = fakeRun({ stdout: '' });
    expect(await systemFolderPicker('win32', {}, run).pick({ title: 'Choose', start: 'C:\\' })).toEqual([]);
    expect(calls[0]!.script).toMatchObject({
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      o: { env: { RELAY_PICK_START: 'C:\\' }, timeoutMs: PICK_TIMEOUT_MS },
    });
  });

  it('is not available, and opens nothing, without a dialog', async () => {
    const { calls, run } = fakeRun({});
    const picker = systemFolderPicker('linux', { PATH: '/nowhere' }, run);
    expect(picker.available()).toBe(false);
    await expect(picker.pick({ title: 'Choose', start: '/' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
