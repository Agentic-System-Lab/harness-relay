import { describe, expect, it } from 'vitest';
import { withLang } from '../src/server/i18n';
import { launchOf } from '../src/server/process';
import { findWindowsCommand, npmShimTarget, windowsLaunch, WindowsScriptError, type LaunchFs } from '../src/server/winLaunch';

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

  it('reads PATH as Node passes it to the child (of Path and PATH, the first in sorted order), and passes over what it cannot start', () => {
    const fs = disk({ 'C:\\Old\\claude.exe': '', 'C:\\New\\claude.exe': '', 'C:\\Js\\claude.js': '', 'C:\\Js2\\claude.exe': '' });
    expect(findWindowsCommand('claude', { Path: 'C:\\Old', PATH: 'C:\\New', PATHEXT: '.EXE' }, fs)).toBe('C:\\New\\claude.exe');
    // A .JS (or .VBS, .PS1…) PATHEXT names, found first, is not taken: Windows would not start it.
    expect(findWindowsCommand('claude', { PATH: 'C:\\Js;C:\\Js2', PATHEXT: '.JS;.EXE' }, fs)).toBe('C:\\Js2\\claude.exe');
  });
});

describe('starting a CLI on Windows', () => {
  it('starts a program as it is, and leaves a command that is not there for spawn to report missing', () => {
    const fs = disk({ 'C:\\Users\\me\\.grok\\bin\\grok.exe': '' });
    expect(windowsLaunch('grok', ['agent', 'stdio'], env('C:\\Users\\me\\.grok\\bin'), fs)).toEqual({ file: 'C:\\Users\\me\\.grok\\bin\\grok.exe', args: ['agent', 'stdio'] });
    // Not there: said so, not started bare (Windows would look in the working directory first).
    expect(windowsLaunch('codex', ['app-server'], env('C:\\nowhere'), fs)).toEqual({ file: 'codex', args: ['app-server'], missing: true });
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
    const onPath = disk({ [`${NPM}\\pi.cmd`]: shim, [script]: '', 'C:\\Program Files\\nodejs\\node.exe': '' });
    expect(windowsLaunch('pi', ['--mode', 'rpc'], env(`${NPM};C:\\Program Files\\nodejs`), onPath, 'C:\\relay\\node.exe')).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: [script, '--mode', 'rpc'],
    });
    const beside = disk({ [`${NPM}\\pi.cmd`]: shim, [script]: '', [`${NPM}\\node.exe`]: '', 'C:\\Program Files\\nodejs\\node.exe': '' });
    expect(windowsLaunch('pi', [], env(`${NPM};C:\\Program Files\\nodejs`), beside).file).toBe(`${NPM}\\node.exe`);
    const none = disk({ [`${NPM}\\pi.cmd`]: shim, [script]: '' });
    expect(windowsLaunch('pi', [], env(NPM), none, 'C:\\relay\\node.exe')).toEqual({ file: 'C:\\relay\\node.exe', args: [script] });
    // No Node at all (the desktop app is no Node): said so.
    expect(() => withLang('en', () => windowsLaunch('pi', [], env(NPM), none, null))).toThrow(`"pi" is ${NPM}\\pi.cmd, which runs on Node.js, and no Node.js is on the PATH`);
    // Its script not there: a broken install, said so.
    expect(() => withLang('en', () => windowsLaunch('pi', [], env(NPM), disk({ [`${NPM}\\pi.cmd`]: shim }), 'C:\\relay\\node.exe'))).toThrow(`and ${script}, which it runs, is not there: install pi again`);
    // Older npm: `%~dp0`, node.exe named in the line.
    const old = disk({
      [`${NPM}\\cline.cmd`]: '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\cline\\bin\\cline" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\node_modules\\cline\\bin\\cline" %*\r\n)\r\n',
      [`${NPM}\\node_modules\\cline\\bin\\cline`]: '',
    });
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
    // The newest folder without its files (an update cut short): the newest whole one.
    const cut = disk({ [`${home}\\cursor-agent.cmd`]: fs.read(`${home}\\cursor-agent.cmd`)!, ...version('2026.11.2-bbbb222'), [`${home}\\versions\\2026.11.11-b912975\\node.exe`]: '' });
    expect(windowsLaunch('cursor-agent', [], env(home), cut).file).toBe(`${home}\\versions\\2026.11.2-bbbb222\\node.exe`);
    // Another script beside such folders is not taken for Cursor's launcher.
    const other = disk({ [`${home}\\mine.cmd`]: '@echo off\r\nmine.exe %*\r\n', ...version('2026.11.2-bbbb222') });
    expect(() => windowsLaunch('mine', [], env(home), other)).toThrow(WindowsScriptError);
  });

  it("starts Muse Code's active binary as its launcher does, the one its .muse-version names", () => {
    const home = 'C:\\Users\\me\\AppData\\Local\\Programs\\muse';
    // `muse.cmd` as Muse's install.ps1 writes it.
    const shim = '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n';
    const fs = disk({
      [`${home}\\muse.cmd`]: shim,
      [`${home}\\.muse-launcher.ps1`]: '',
      [`${home}\\.muse-version`]: '1.4.18-R8587.1\r\n',
      [`${home}\\muse-bin-1.4.18-R8587.1.exe`]: '',
      [`${home}\\muse-bin-1.4.17-R8100.exe`]: '',
    });
    expect(windowsLaunch('muse', ['acp'], env(home), fs)).toEqual({ file: `${home}\\muse-bin-1.4.18-R8587.1.exe`, args: ['acp'] });
    // No binary for the version it names (an update cut short), or no version: the run fails saying so.
    const cut = disk({ [`${home}\\muse.cmd`]: shim, [`${home}\\.muse-version`]: '1.4.19-R9000' });
    expect(() => windowsLaunch('muse', [], env(home), cut)).toThrow(WindowsScriptError);
    const odd = disk({ [`${home}\\muse.cmd`]: shim, [`${home}\\.muse-version`]: '..\\..\\evil', [`${home}\\muse-bin-..\\..\\evil.exe`]: '' });
    expect(() => windowsLaunch('muse', [], env(home), odd)).toThrow(WindowsScriptError);
  });

  it("takes a script for npm's shim only when every line of it is one npm writes, for Node", () => {
    expect(npmShimTarget(programShim('node_modules\\x\\x.exe'))).toEqual({ program: 'node_modules\\x\\x.exe' });
    expect(npmShimTarget(nodeShim('node_modules\\x\\cli.js'))).toEqual({ node: 'node_modules\\x\\cli.js' });
    // A script of the user's own that sets something first: what it sets would be lost.
    const mine = `@echo off\r\nset CLAUDE_CODE_USE_BEDROCK=1\r\nset AWS_PROFILE=work\r\n"%~dp0\\bin\\claude.exe" %*\r\n`;
    expect(npmShimTarget(mine)).toBeUndefined();
    const fs = disk({ 'C:\\Tools\\claude.cmd': mine, 'C:\\Tools\\bin\\claude.exe': '' });
    expect(() => windowsLaunch('claude', [], env('C:\\Tools'), fs)).toThrow(WindowsScriptError);
    // A shim for another interpreter (bun, deno, sh…) is not one for Node.
    expect(npmShimTarget(nodeShim('node_modules\\x\\cli.ts').replace('SET "_prog=node"', 'SET "_prog=bun"'))).toBeUndefined();
    // Nor one that runs two different things.
    expect(npmShimTarget(`${programShim('a.exe')}"%dp0%\\b.exe"   %*\r\n`)).toBeUndefined();
  });

  it('does not start a script whose program it cannot tell, and says why', () => {
    const fs = disk({ 'C:\\Tools\\mycli.bat': '@echo off\r\npowershell -File mycli.ps1 %*\r\n' });
    expect(() => windowsLaunch('mycli', [], env('C:\\Tools'), fs)).toThrow(WindowsScriptError);
    expect(() => withLang('en', () => windowsLaunch('mycli', [], env('C:\\Tools'), fs))).toThrow('"mycli" is the script C:\\Tools\\mycli.bat, which Harness Relay cannot start');
    expect(() => windowsLaunch('mycli', [], env('C:\\Tools'), fs)).toThrow('「mycli」是腳本 C:\\Tools\\mycli.bat，Harness Relay 無法啟動它');
    // Nor a shim whose program is not there: a broken install, said so.
    const gone = disk({ [`${NPM}\\opencode.cmd`]: programShim('node_modules\\opencode-ai\\bin\\opencode.exe') });
    expect(() => withLang('en', () => windowsLaunch('opencode', [], env(NPM), gone))).toThrow('which it runs, is not there: install opencode again');
  });

  it('is used on Windows only', () => {
    expect(launchOf('claude', ['-p'], { PATH: '/usr/bin' }, 'darwin')).toEqual({ file: 'claude', args: ['-p'] });
    expect(launchOf('codex', ['app-server'], { PATH: '/usr/bin' }, 'linux')).toEqual({ file: 'codex', args: ['app-server'] });
  });
});
