import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { browserDataDirs, protectedReads, relayDatabaseFiles, relayFolderOverlap, relayFolderRefusal, relayTmpDir, RELAY_ROOT } from '../src/server/protect';
import { withLang } from '../src/server/i18n';

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
    symlinkSync(join(root, 'elsewhere'), join(home, '.zen'));
    mkdirSync(join(root, 'elsewhere'));
    const paths = protectedReads({ platform: 'linux', home, dataDir: data });
    expect(paths).toContain(join(home, '.mozilla'));
    expect(paths).toContain(join(data, 'relay.db'));
    // Its own temporary folder too, where a Claude Code turn's settings and MCP config wait.
    expect(paths).toContain(relayTmpDir(data));
    expect(relayTmpDir('/d')).toBe('/d/tmp');
    // A folder that is a link: both the link and where it leads.
    expect(paths).toContain(join(home, '.zen'));
    expect(paths).toContain(join(root, 'elsewhere'));
    // Not there: left out, so a sandbox does not refuse to start over it.
    expect(paths).not.toContain(join(home, '.config/google-chrome'));
    expect(paths).not.toContain(join(data, 'relay.db-wal'));
    expect(relayDatabaseFiles('/d')).toEqual(['/d/relay.db', '/d/relay.db-wal', '/d/relay.db-shm']);
    expect(protectedReads({ platform: 'win32', home, dataDir: data })).toEqual([]);
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

  it('is refused in edit mode only, where agents change files without asking', () => {
    const why = withLang('en', () => relayFolderRefusal({ permission: 'edit', cwd: RELAY_ROOT }));
    expect(why).toMatch(/holds Harness Relay itself/);
    expect(relayFolderRefusal({ permission: 'read-only', cwd: RELAY_ROOT })).toBeUndefined();
    expect(relayFolderRefusal({ permission: 'full', cwd: RELAY_ROOT })).toBeUndefined();
  });
});
