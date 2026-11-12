import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  agentFolderOverlap,
  appBrowserDirs,
  browserDataDirs,
  clearRunTmp,
  commandPaths,
  overlaps,
  patternPath,
  protectedReads,
  relayDatabaseFiles,
  relayFolderOverlap,
  relayFolderRefusal,
  relayTmpDir,
  RELAY_ROOT,
  dirInTemp,
  voiceDirProblem,
  voiceFolder,
} from '../src/server/protect';
import { withLang } from '../src/server/i18n';
import { DATA_DIR } from '../src/server/settings';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-protect-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('what agents may not read', () => {
  it("lists the browsers' folders on macOS and Linux, none on Windows", () => {
    const mac = browserDataDirs('darwin', '/Users/me');
    expect(mac).toContain('/Users/me/Library/Application Support/Google/Chrome');
    expect(mac).toContain('/Users/me/Library/Application Support/Firefox');
    expect(mac).toContain('/Users/me/Library/Safari');
    const linux = browserDataDirs('linux', '/home/me');
    expect(linux).toContain('/home/me/.config/google-chrome');
    expect(linux).toContain('/home/me/.mozilla');
    expect(linux).toContain('/home/me/snap/firefox');
    expect(linux).toContain('/home/me/.config/mozilla'); // Firefox 147 and later
    // A config folder moved with XDG_CONFIG_HOME is looked at too, once.
    const xdg = browserDataDirs('linux', '/home/me', '/data/me/config');
    expect(xdg).toContain('/data/me/config/google-chrome');
    expect(xdg).toContain('/home/me/.config/google-chrome');
    expect(browserDataDirs('linux', '/home/me', '/home/me/.config').filter((d) => d.endsWith('/google-chrome'))).toHaveLength(1);
    expect(browserDataDirs('linux', '/home/me', 'relative')).toEqual(browserDataDirs('linux', '/home/me', ''));
    expect(browserDataDirs('win32', 'C:\\Users\\me')).toEqual([]);
  });

  it('takes the folders and database files that exist, also by their real paths', () => {
    const home = join(root, 'home');
    const data = join(root, 'data');
    mkdirSync(join(home, '.mozilla'), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'relay.db'), '');
    mkdirSync(join(data, 'tmp'));
    // A link to a folder (Windows makes a link to a file of one whose target is not there yet).
    symlinkSync(join(root, 'elsewhere'), join(home, '.zen'), 'dir');
    mkdirSync(join(root, 'elsewhere'));
    // Compared as this system writes paths: on Windows, where only a test asks for Linux's, `/` becomes `\`.
    const paths = protectedReads({ platform: 'linux', home, dataDir: data }).map((p) => resolve(p));
    expect(paths).toContain(join(home, '.mozilla'));
    expect(paths).toContain(join(data, 'relay.db'));
    // Its own temporary folder too, where a Claude Code turn's settings and MCP config wait.
    expect(paths).toContain(relayTmpDir(data));
    expect(relayTmpDir('/d')).toBe(join('/d', 'tmp'));
    // A folder that is a link: both the link and where it leads.
    expect(paths).toContain(join(home, '.zen'));
    expect(paths).toContain(join(root, 'elsewhere'));
    // Not there: left out, so a sandbox does not refuse to start over it.
    expect(paths).not.toContain(join(home, '.config/google-chrome'));
    expect(paths).not.toContain(join(data, 'relay.db-wal'));
    expect(relayDatabaseFiles('/d')).toEqual(['relay.db', 'relay.db-wal', 'relay.db-shm'].map((f) => join('/d', f)));
    expect(protectedReads({ platform: 'win32', home, dataDir: data })).toEqual([]);
  });

  it("takes the desktop app's own browser folder, where its window keeps its cookie and key", () => {
    const home = join(root, 'home-app');
    const browser = join(root, 'Harness Relay', 'browser');
    mkdirSync(browser, { recursive: true });
    mkdirSync(home, { recursive: true });
    const env = { RELAY_APP_BROWSER_DIR: browser };
    expect(appBrowserDirs(env)).toEqual([browser]);
    expect(protectedReads({ platform: 'darwin', home, dataDir: join(root, 'no-data'), env })).toContain(browser);
    // Started any other way, or with a relative or missing folder, there is none.
    expect(appBrowserDirs({})).toEqual([]);
    expect(appBrowserDirs({ RELAY_APP_BROWSER_DIR: 'browser' })).toEqual([]);
    expect(protectedReads({ platform: 'linux', home, dataDir: join(root, 'no-data'), env: { RELAY_APP_BROWSER_DIR: join(root, 'missing') } })).toEqual([]);
  });
});

describe("Harness Relay's own folder as a working directory", () => {
  const install = join(root, 'relay');
  const data = join(install, 'data');
  mkdirSync(join(install, 'src/server'), { recursive: true });
  mkdirSync(join(data, 'worktrees/conv/alice'), { recursive: true });
  const roots = { install, data };

  it('is refused when it holds the code or the data, or is inside the code', () => {
    expect(relayFolderOverlap(install, roots)).toBe('data');
    expect(relayFolderOverlap(root, roots)).toBe('data');
    expect(relayFolderOverlap(data, roots)).toBe('data');
    expect(relayFolderOverlap(join(install, 'src/server'), roots)).toBe('install');
    // Data kept elsewhere: the code folder still holds the code.
    expect(relayFolderOverlap(install, { install, data: join(root, 'other-data') })).toBe('install');
    // A link to it is it.
    symlinkSync(install, join(root, 'link'));
    expect(relayFolderOverlap(join(root, 'link'), roots)).toBe('data');
  });

  it("is fine for the worktrees in its data folder and any other folder", () => {
    expect(relayFolderOverlap(join(data, 'worktrees/conv/alice'), roots)).toBeUndefined();
    mkdirSync(join(root, 'project'));
    expect(relayFolderOverlap(join(root, 'project'), roots)).toBeUndefined();
  });

  it('is refused when it holds voice input\'s folder that RELAY_VOICE_DIR puts elsewhere, or is inside it', () => {
    const voice = join(root, 'models/voice');
    mkdirSync(join(voice, 'engine'), { recursive: true });
    mkdirSync(join(root, 'models/other'), { recursive: true });
    const withVoice = { ...roots, voice };
    expect(relayFolderOverlap(root, withVoice)).toBe('data'); // it holds the data folder too
    expect(relayFolderOverlap(join(root, 'models'), withVoice)).toBe('voice');
    expect(relayFolderOverlap(voice, withVoice)).toBe('voice');
    expect(relayFolderOverlap(join(voice, 'engine'), withVoice)).toBe('voice');
    // Beside it is fine, and so is the same folder when voice input keeps to the data folder.
    expect(relayFolderOverlap(join(root, 'models/other'), withVoice)).toBeUndefined();
    expect(relayFolderOverlap(join(root, 'models'), roots)).toBeUndefined();
    // The data folder's own voice folder is no place to work in either, unlike its worktrees.
    expect(relayFolderOverlap(join(data, 'voice/engine'), roots)).toBe('voice');
    expect(voiceFolder(data)).toBe(join(data, 'voice'));
  });

  it('says why when the working directory holds voice input\'s folder', () => {
    const own = join(DATA_DIR, 'voice', 'engine');
    const why = withLang('en', () => relayFolderRefusal({ permission: 'edit', cwd: own }));
    expect(why).toContain(`holds voice input's folder ${join(DATA_DIR, 'voice')}, or is inside it.`);
    // The default folder: no variable to name.
    expect(why).not.toContain('RELAY_VOICE_DIR');
    expect(withLang('zh-TW', () => relayFolderRefusal({ permission: 'edit', cwd: own }))).toContain('語音輸入的資料夾');
    expect(relayFolderRefusal({ permission: 'read-only', cwd: own })).toBeUndefined();
  });

  it('refuses a voice folder in a temp folder at startup, where sandboxes could replace the engine', () => {
    expect(voiceDirProblem(undefined)).toBeUndefined();
    expect(voiceDirProblem('/srv/relay-voice')).toBeUndefined();
    expect(dirInTemp('/srv/relay-voice')).toBe(false);
    if (process.platform === 'win32') {
      // No sandbox there to write in it.
      expect(voiceDirProblem(join(tmpdir(), 'voice'))).toBeUndefined();
      return;
    }
    expect(dirInTemp(join(tmpdir(), 'voice'))).toBe(true);
    expect(dirInTemp('/tmp/voice')).toBe(true);
    expect(voiceDirProblem(join(tmpdir(), 'voice'))).toMatch(/^RELAY_VOICE_DIR=.* is in a temp folder/);
  });

  it('is refused in edit mode only, where agents change files without asking', () => {
    const why = withLang('en', () => relayFolderRefusal({ permission: 'edit', cwd: RELAY_ROOT }));
    expect(why).toMatch(/holds Harness Relay itself/);
    expect(relayFolderRefusal({ permission: 'read-only', cwd: RELAY_ROOT })).toBeUndefined();
    expect(relayFolderRefusal({ permission: 'full', cwd: RELAY_ROOT })).toBeUndefined();
  });
});

describe('what decides how the agents run, as a working directory', () => {
  const home = join(root, 'me');
  mkdirSync(join(home, 'projects/app'), { recursive: true });
  mkdirSync(join(home, '.codex/packages/bin'), { recursive: true });
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  const o = { home, env: {}, agentHome: join(home, 'relay-agents'), bins: [join(home, '.local/bin/claude')] };

  it('refuses the home folder and what holds it, but not a project inside it', () => {
    expect(agentFolderOverlap(home, o)).toBe(home);
    expect(agentFolderOverlap(root, o)).toBe(home);
    expect(agentFolderOverlap(join(home, 'projects/app'), o)).toBeUndefined();
  });

  it("refuses a CLI's own folder, the CLIs' folder Harness Relay gives them and a program's folder, holding them or inside them", () => {
    expect(agentFolderOverlap(join(home, '.codex'), o)).toBe(join(home, '.codex'));
    expect(agentFolderOverlap(join(home, '.codex/packages/bin'), o)).toBe(join(home, '.codex'));
    expect(agentFolderOverlap(join(home, '.local'), o)).toBe(join(home, '.local/bin'));
    expect(agentFolderOverlap(join(home, 'relay-agents/grok'), o)).toBe(join(home, 'relay-agents'));
    // A CLI home moved by its variable.
    expect(agentFolderOverlap(join(root, 'elsewhere'), { ...o, env: { CODEX_HOME: join(root, 'elsewhere/codex') } })).toBe(join(root, 'elsewhere/codex'));
    // Cursor's: its config folder, and ~/.cursor, where its hooks and MCP servers stay when that moves.
    expect(agentFolderOverlap(join(home, '.cursor/rules'), o)).toBe(join(home, '.cursor'));
    const moved = { ...o, env: { CURSOR_CONFIG_DIR: join(root, 'elsewhere/cursor') } };
    expect(agentFolderOverlap(join(root, 'elsewhere/cursor/x'), moved)).toBe(join(root, 'elsewhere/cursor'));
    expect(agentFolderOverlap(join(home, '.cursor'), moved)).toBe(join(home, '.cursor'));
    const xdg = { ...o, env: { XDG_CONFIG_HOME: join(root, 'xdg') } };
    expect(agentFolderOverlap(join(root, 'xdg/cursor/rules'), xdg)).toBe(join(root, 'xdg/cursor'));
    // Where it keeps its sign-in on Linux, also with its config folder moved.
    expect(agentFolderOverlap(join(home, '.config/cursor'), moved)).toBe(join(home, '.config/cursor'));
    // And on Windows, in %APPDATA%.
    expect(agentFolderOverlap(join(root, 'appdata/Cursor/x'), { ...o, env: { APPDATA: join(root, 'appdata') } })).toBe(join(root, 'appdata/Cursor'));
    // Antigravity's .gemini folder (its hooks, MCP servers, plugins), the user's own and the account's.
    expect(agentFolderOverlap(join(home, '.gemini/config'), o)).toBe(join(home, '.gemini'));
    const account = { ...o, env: { HARNESS_RELAY_ANTIGRAVITY_HOME: join(root, 'accounts/antigravity-a1') } };
    expect(agentFolderOverlap(join(root, 'accounts/antigravity-a1/.gemini/antigravity-cli'), account)).toBe(join(root, 'accounts/antigravity-a1/.gemini'));
    expect(agentFolderOverlap(join(home, '.gemini'), account)).toBe(join(home, '.gemini'));
  });

  it("refuses the folder of the other accounts' homes, and a project in one of them", () => {
    const accountsDir = join(root, 'data/accounts');
    const withAccounts = { ...o, accountsDir };
    expect(agentFolderOverlap(join(accountsDir, 'claude-ab12cd34'), withAccounts)).toBe(accountsDir);
    expect(agentFolderOverlap(join(accountsDir, 'codex-ab12cd34/project'), withAccounts)).toBe(accountsDir);
    expect(agentFolderOverlap(join(home, 'projects/app'), withAccounts)).toBeUndefined();
    // With the CLIs' own folder set, the other accounts are in it.
    expect(agentFolderOverlap(join(home, 'relay-agents/claude-ab12cd34'), { ...o, accountsDir: o.agentHome })).toBe(join(home, 'relay-agents'));
  });

  it('sees a folder still to be made through the links and letter case on its way', () => {
    // A link to a CLI's folder, and the folder to be made in it: refused before it exists.
    symlinkSync(join(home, '.codex'), join(home, 'projects/codex-link'));
    expect(agentFolderOverlap(join(home, 'projects/codex-link/new/app'), o)).toBe(join(home, '.codex'));
    expect(relayFolderOverlap(join(root, 'relay-link/new'), { install: join(root, 'relay'), data: join(root, 'relay/data') })).toBeUndefined();
    mkdirSync(join(root, 'relay/data'), { recursive: true });
    symlinkSync(join(root, 'relay'), join(root, 'relay-link'));
    expect(relayFolderOverlap(join(root, 'relay-link/new'), { install: join(root, 'relay'), data: join(root, 'relay/data') })).toBe('install');
    expect(overlaps(join(root, 'relay-link/data/new'), join(root, 'relay/data'))).toBe(true);
  });

  it('is refused in edit mode with its own reason', () => {
    expect(withLang('en', () => relayFolderRefusal({ permission: 'edit', cwd: root }, o))).toMatch(/where files decide how the agents run/);
    expect(relayFolderRefusal({ permission: 'read-only', cwd: root }, o)).toBeUndefined();
  });
});

describe('finding a CLI and naming protected paths', () => {
  it('finds a command on the PATH, by where it was found and its real path', () => {
    const bin = join(root, 'bin');
    const real = join(root, 'versions');
    mkdirSync(bin, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'tool-1.0'), '');
    symlinkSync(join(real, 'tool-1.0'), join(bin, 'tool'));
    expect(commandPaths('tool', { PATH: ['/nowhere', bin].join(delimiter) })).toEqual([join(bin, 'tool'), join(real, 'tool-1.0')]);
    expect(commandPaths(join(bin, 'tool'))).toEqual([join(bin, 'tool'), join(real, 'tool-1.0')]);
    expect(commandPaths('missing-tool', { PATH: bin })).toEqual([]);
    // On Windows, by its extensions; a folder of that name is not the command.
    writeFileSync(join(bin, 'win-tool.EXE'), '');
    mkdirSync(join(bin, 'dir-tool'));
    expect(commandPaths('win-tool', { PATH: bin, PATHEXT: '.COM;.EXE' }, 'win32')).toEqual([join(bin, 'win-tool.EXE')]);
    expect(commandPaths('win-tool', { PATH: bin }, 'linux')).toEqual([]);
    expect(commandPaths('dir-tool', { PATH: bin }, 'linux')).toEqual([]);
  });

  it('flags a path the sandboxes would read as a pattern, and tells overlapping paths', () => {
    expect(patternPath(['/a/b', '/home/me [1]/data/relay.db'])).toBe('/home/me [1]/data/relay.db');
    expect(patternPath(['/a/b*'])).toBe('/a/b*');
    expect(patternPath(['/a/b', '/c'])).toBeUndefined();
    expect(overlaps('/a/b', '/a/b/c')).toBe(true);
    expect(overlaps('/a/b/c', '/a')).toBe(true);
    expect(overlaps('/a/bc', '/a/b')).toBe(false);
  });
});

describe("the turns' own temporary folders", () => {
  it('removes those of turns the server was stopped during, and nothing else, nor what a link in one leads to', () => {
    const tmp = join(root, 'run-tmp');
    const sessions = join(root, 'cursor-account', 'acp-sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'chat.json'), '{}');
    // A Claude Code turn's settings (with an endpoint's key), a Cursor turn's config folder with its link.
    mkdirSync(join(tmp, 'claude-a1B2c3'), { recursive: true });
    writeFileSync(join(tmp, 'claude-a1B2c3', 'settings.json'), '{"env":{"ANTHROPIC_AUTH_TOKEN":"lab-key"}}');
    mkdirSync(join(tmp, 'cursor-x9Y8z7'));
    writeFileSync(join(tmp, 'cursor-x9Y8z7', 'cli-config.json'), '{}');
    symlinkSync(sessions, join(tmp, 'cursor-x9Y8z7', 'acp-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    // What others keep there: shares' clones (cleared by shares), Grok's kept programs.
    mkdirSync(join(tmp, 'share-k1'));
    mkdirSync(join(tmp, 'grok-programs'));
    clearRunTmp(tmp);
    expect(readdirSync(tmp).sort()).toEqual(['grok-programs', 'share-k1']);
    expect(existsSync(join(sessions, 'chat.json'))).toBe(true);
    // None yet: nothing to do.
    expect(() => clearRunTmp(join(root, 'no-tmp-yet'))).not.toThrow();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('goes on past one it cannot remove, and names it', () => {
    const tmp = join(root, 'run-tmp-locked');
    // Its own folder may not be written in: what is in it cannot be removed.
    mkdirSync(join(tmp, 'claude-l0cked', 'inner'), { recursive: true });
    writeFileSync(join(tmp, 'claude-l0cked', 'inner', 'settings.json'), '{}');
    chmodSync(join(tmp, 'claude-l0cked', 'inner'), 0o500);
    mkdirSync(join(tmp, 'cursor-0pen00'));
    try {
      expect(() => clearRunTmp(tmp)).toThrow(/claude-l0cked/);
      expect(readdirSync(tmp)).toEqual(['claude-l0cked']);
    } finally {
      chmodSync(join(tmp, 'claude-l0cked', 'inner'), 0o700);
    }
  });
});
