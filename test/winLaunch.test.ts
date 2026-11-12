import { describe, expect, it } from 'vitest';
import { withLang } from '../src/server/i18n';
import { launchOf } from '../src/server/process';
import { findWindowsCommand, windowsLaunch, WindowsScriptError, type LaunchFs } from '../src/server/winLaunch';

/** A disk of Windows paths: files with their text, and the folders they make. */
function disk(files: Record<string, string>): LaunchFs {
  const key = (p: string) => p.toLowerCase();
  const all = new Map(Object.entries(files).map(([p, text]) => [key(p), text]));
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) for (let d = p; d.includes('\\'); d = d.slice(0, d.lastIndexOf('\\'))) dirs.add(key(d.slice(0, d.lastIndexOf('\\'))));
  return {
    isFile: (p) => all.has(key(p)),
    isDir: (p) => dirs.has(key(p)),
    read: (p) => all.get(key(p)),
    list: (d) => [
      ...new Set(
        Object.keys(files)
          .filter((p) => key(p).startsWith(`${key(d)}\\`))
          .map((p) => p.slice(d.length + 1).split('\\')[0]!),
      ),
    ],
  };
}

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const PREAMBLE = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
// npm's cmd-shim, as npm 11 writes it: a program, and a Node script.
const programShim = (rel: string) => `${PREAMBLE}"%dp0%\\${rel}"   %*\r\n`;
const nodeShim = (rel: string) =>
  `${PREAMBLE}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n` +
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;
const env = (path: string, more: Record<string, string> = {}) => ({ Path: path, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', ...more });

describe('finding a CLI on Windows', () => {
  it('takes the first match on the PATH in PATHEXT order, as a shell does, whatever the letter case of PATH', () => {
    const fs = disk({ [`${NPM}\\claude.cmd`]: programShim('x.exe'), 'C:\\Tools\\claude.exe': '', 'C:\\Tools\\claude': 'not a program' });
    expect(findWindowsCommand('claude', env(`${NPM};C:\\Tools`), fs)).toBe(`${NPM}\\claude.cmd`);
    expect(findWindowsCommand('claude', env(`C:\\Tools;${NPM}`), fs)).toBe('C:\\Tools\\claude.exe');
    expect(findWindowsCommand('claude', { PATH: `C:\\Tools` }, fs)).toBe('C:\\Tools\\claude.exe');
    // A path, with or without its extension; a file without one of PATHEXT's is never taken.
    expect(findWindowsCommand(`${NPM}\\claude`, env(''), fs)).toBe(`${NPM}\\claude.cmd`);
    expect(findWindowsCommand('C:\\Tools\\claude.exe', env(''), fs)).toBe('C:\\Tools\\claude.exe');
    expect(findWindowsCommand('missing', env(`${NPM};C:\\Tools`), fs)).toBeUndefined();
    // Programs only, when asked.
    expect(findWindowsCommand('claude', env(`${NPM};C:\\Tools`), fs, ['.exe', '.com'])).toBe('C:\\Tools\\claude.exe');
  });
});

describe('starting a CLI on Windows', () => {
  it('starts a program as it is, and leaves a command that is not there for spawn to report missing', () => {
    const fs = disk({ 'C:\\Users\\me\\.grok\\bin\\grok.exe': '' });
    expect(windowsLaunch('grok', ['agent', 'stdio'], env('C:\\Users\\me\\.grok\\bin'), fs)).toEqual({ file: 'C:\\Users\\me\\.grok\\bin\\grok.exe', args: ['agent', 'stdio'] });
    expect(windowsLaunch('codex', ['app-server'], env('C:\\nowhere'), fs)).toEqual({ file: 'codex', args: ['app-server'] });
  });

  it("starts the program an npm shim names (Claude Code's, OpenCode's)", () => {
    const fs = disk({
      [`${NPM}\\claude.cmd`]: programShim('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
      [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]: '',
    });
    expect(windowsLaunch('claude', ['-p', '--output-format', 'stream-json'], env(NPM), fs)).toEqual({
      file: `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
      args: ['-p', '--output-format', 'stream-json'],
    });
  });

  it("runs the script an npm shim names with Node: the one beside it, else the PATH's, else Harness Relay's (Codex, Cline, Pi)", () => {
    const shim = nodeShim('node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js');
    const script = `${NPM}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js`;
    const onPath = disk({ [`${NPM}\\pi.cmd`]: shim, 'C:\\Program Files\\nodejs\\node.exe': '' });
    expect(windowsLaunch('pi', ['--mode', 'rpc'], env(`${NPM};C:\\Program Files\\nodejs`), onPath, 'C:\\relay\\node.exe')).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: [script, '--mode', 'rpc'],
    });
    const beside = disk({ [`${NPM}\\pi.cmd`]: shim, [`${NPM}\\node.exe`]: '', 'C:\\Program Files\\nodejs\\node.exe': '' });
    expect(windowsLaunch('pi', [], env(`${NPM};C:\\Program Files\\nodejs`), beside).file).toBe(`${NPM}\\node.exe`);
    const none = disk({ [`${NPM}\\pi.cmd`]: shim });
    expect(windowsLaunch('pi', [], env(NPM), none, 'C:\\relay\\node.exe')).toEqual({ file: 'C:\\relay\\node.exe', args: [script] });
    // Older npm: `%~dp0`, node.exe named in the line.
    const old = disk({ [`${NPM}\\cline.cmd`]: '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\cline\\bin\\cline" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\cline\\bin\\cline" %*\r\n)\r\n' });
    expect(windowsLaunch('cline', ['--acp'], env(NPM), old, 'C:\\relay\\node.exe')).toEqual({ file: 'C:\\relay\\node.exe', args: [`${NPM}\\node_modules\\cline\\bin\\cline`, '--acp'] });
  });

  it("starts Cursor's newest version as its launcher does, saying how it was invoked", () => {
    const home = 'C:\\Users\\me\\AppData\\Local\\cursor-agent';
    const version = (name: string) => ({ [`${home}\\versions\\${name}\\node.exe`]: '', [`${home}\\versions\\${name}\\index.js`]: '' });
    const fs = disk({
      [`${home}\\cursor-agent.cmd`]: '@echo off\r\nset "CURSOR_INVOKED_AS=%~nx0"\r\n%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*\r\n',
      [`${home}\\versions\\promote-staged.cmd`]: '',
      ...version('2026.9.30-aaaa111'),
      ...version('2026.11.2-bbbb222'),
      ...version('2026.11.11-b912975'),
      ...version('2026.11.11-10-00-00-c0ffee1'),
      [`${home}\\versions\\not-a-version\\node.exe`]: '',
    });
    const newest = `${home}\\versions\\2026.11.11-b912975`;
    expect(windowsLaunch('cursor-agent', ['acp'], env(home, { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), fs)).toEqual({
      file: `${newest.replace('b912975', '10-00-00-c0ffee1')}\\node.exe`,
      args: [`${newest.replace('b912975', '10-00-00-c0ffee1')}\\index.js`, 'acp'],
      env: { CURSOR_INVOKED_AS: 'cursor-agent.cmd', NODE_COMPILE_CACHE: 'C:\\Users\\me\\AppData\\Local\\cursor-compile-cache' },
    });
    // A compile cache of the user's own is kept.
    expect(windowsLaunch('cursor-agent', [], env(home, { NODE_COMPILE_CACHE: 'D:\\cache' }), fs).env).toEqual({ CURSOR_INVOKED_AS: 'cursor-agent.cmd' });
  });

  it('does not start a script whose program it cannot tell, and says why', () => {
    const fs = disk({ 'C:\\Tools\\mycli.bat': '@echo off\r\npowershell -File mycli.ps1 %*\r\n' });
    expect(() => windowsLaunch('mycli', [], env('C:\\Tools'), fs)).toThrow(WindowsScriptError);
    expect(() => withLang('en', () => windowsLaunch('mycli', [], env('C:\\Tools'), fs))).toThrow('"mycli" is the script C:\\Tools\\mycli.bat, which Harness Relay cannot start');
    expect(() => windowsLaunch('mycli', [], env('C:\\Tools'), fs)).toThrow('「mycli」是指令稿 C:\\Tools\\mycli.bat，Harness Relay 無法啟動它');
    // Nor a shim whose program is not there.
    const gone = disk({ [`${NPM}\\opencode.cmd`]: programShim('node_modules\\opencode-ai\\bin\\opencode.exe') });
    expect(() => windowsLaunch('opencode', [], env(NPM), gone)).toThrow(WindowsScriptError);
  });

  it('is used on Windows only', () => {
    expect(launchOf('claude', ['-p'], { PATH: '/usr/bin' }, 'darwin')).toEqual({ file: 'claude', args: ['-p'] });
    expect(launchOf('codex', ['app-server'], { PATH: '/usr/bin' }, 'linux')).toEqual({ file: 'codex', args: ['app-server'] });
  });
});
