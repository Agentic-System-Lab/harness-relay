import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/server/db';
import { withLang } from '../src/server/i18n';
import type { SecretStore } from '../src/server/secrets';
import { ToolLibrary, findSkills, parseFrontMatter, scanSkills } from '../src/server/tools';
import { PROVIDERS, type AgentConfig } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-tools-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function skill(dir: string, frontMatter: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontMatter}\n---\n\n# Steps\n`);
  return dir;
}

function fakeKeyring(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    storage: 'keychain',
    data,
    get: (name) => data.get(name) ?? null,
    set: (name, value) => void data.set(name, value),
    delete: (name) => void data.delete(name),
  };
}

/** Runs `fn` with server messages in English. */
const en = (fn: () => unknown) => () => withLang('en', fn);
const agent = (provider: AgentConfig['provider'], tools?: AgentConfig['tools']) => ({ provider, tools });
const stored = (db: Database) =>
  JSON.parse((db.prepare("SELECT value FROM app_settings WHERE key = 'tool_library'").get() as { value: string }).value);
/** A server's id, from the library's view. */
const idOf = (lib: ToolLibrary, name: string) => lib.view().mcpServers.find((s) => s.name === name)!.id;
/** A server's entry in the credential store: named after its id, so a rename keeps it. */
const entry = (lib: ToolLibrary, name: string) => `mcp-${idOf(lib, name)}`;

describe('parseFrontMatter', () => {
  it('reads plain, quoted and block values', () => {
    expect(
      parseFrontMatter(`---
name: commit
description: "Write a commit: \\"why\\" first"
other: 'it''s'
---
body`),
    ).toEqual({ name: 'commit', description: 'Write a commit: "why" first', other: "it's" });
    expect(parseFrontMatter('---\nname: review\ndescription: >\n  Review a diff\n  for bugs.\n---\n').description).toBe(
      'Review a diff for bugs.',
    );
    expect(parseFrontMatter('---\ndescription: |\n  line one\n  line two\n---\n').description).toBe('line one\nline two');
    expect(parseFrontMatter('---\ndescription: starts here\n  and goes on\nname: x\n---\n')).toEqual({
      description: 'starts here and goes on',
      name: 'x',
    });
  });

  it('is empty without front matter', () => {
    expect(parseFrontMatter('# Just a heading\nname: x')).toEqual({});
  });
});

describe('finding skills', () => {
  const dir = join(root, 'find');
  const a = skill(join(dir, 'a'), 'name: a');
  const b = skill(join(dir, 'b'), 'name: b');
  const nested = skill(join(dir, 'pack', 'c'), 'name: c');
  skill(join(dir, 'pack', 'deeper', 'too-deep'), 'name: too-deep');
  skill(join(a, 'inside-a'), 'name: inside');
  mkdirSync(join(dir, 'not-a-skill'));
  skill(join(dir, '.hidden'), 'name: hidden');
  skill(join(dir, 'node_modules', 'x'), 'name: x');

  it('finds the skills under a folder: two levels down, not inside a skill or hidden folders', () => {
    expect(scanSkills(dir)).toEqual([a, b, nested]);
    expect(scanSkills(join(dir, 'not-a-skill'))).toEqual([]);
    expect(scanSkills(join(dir, 'missing'))).toEqual([]);
  });

  it('lists a folder that is a skill itself together with the skills in it', () => {
    // Like ~/.claude/skills with a stray SKILL.md at its top.
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: top\n---\n');
    try {
      expect(scanSkills(dir)).toEqual([dir, a, b, nested]);
      expect(scanSkills(join(dir, 'SKILL.md'))).toEqual([dir]);
      // Adding a path directly adds the skill it names, or everything under a folder that is none.
      expect(findSkills(dir)).toEqual([dir]);
    } finally {
      rmSync(join(dir, 'SKILL.md'));
    }
    expect(findSkills(dir)).toEqual([a, b, nested]);
    expect(findSkills(join(a, 'SKILL.md'))).toEqual([a]);
  });
});

describe('ToolLibrary', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('keeps MCP secrets in the credential store and shows them masked', () => {
    const keyring = fakeKeyring();
    const lib = new ToolLibrary(db, keyring);
    const view = lib.saveServer('github', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: [{ name: 'GITHUB_TOKEN', value: 'ghp_1234567890abcdef' }],
    });
    expect(view.mcpServers[0]).toMatchObject({
      name: 'github',
      env: [{ name: 'GITHUB_TOKEN', masked: 'ghp…def' }],
      providers: PROVIDERS,
    });
    expect(view.secretStorage).toBe('keychain');
    expect(JSON.stringify(stored(db))).not.toContain('ghp_1234567890abcdef');
    expect([...keyring.data.keys()]).toEqual([entry(lib, 'github')]);
    expect(JSON.parse(keyring.data.get(entry(lib, 'github'))!)).toEqual({ env: { GITHUB_TOKEN: 'ghp_1234567890abcdef' }, headers: {} });
    // A restart reads the values back.
    expect(new ToolLibrary(db, keyring).forAgent(agent('claude')).mcpServers[0]!.env).toEqual({ GITHUB_TOKEN: 'ghp_1234567890abcdef' });
  });

  it('keeps a value that is not sent again, and carries values over a rename', () => {
    const keyring = fakeKeyring();
    const lib = new ToolLibrary(db, keyring);
    lib.saveServer('api', { transport: 'http', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer abc' }] });
    const before = entry(lib, 'api');
    lib.saveServer('docs', {
      transport: 'http',
      url: 'https://x.test/mcp2',
      headers: [{ name: 'Authorization' }, { name: 'X-Extra', value: '1' }],
      previousName: 'api',
    });
    // The same entry: a rename does not touch the credential store's names.
    expect([...keyring.data.keys()]).toEqual([before]);
    expect(entry(lib, 'docs')).toBe(before);
    expect(lib.forAgent(agent('codex')).mcpServers).toEqual([
      {
        name: 'docs',
        transport: 'http',
        command: '',
        args: [],
        url: 'https://x.test/mcp2',
        env: {},
        headers: { Authorization: 'Bearer abc', 'X-Extra': '1' },
      },
    ]);
  });

  it('keeps the values over a rename in letter case only, on a store whose names ignore case', () => {
    // Like Windows Credential Manager: `mcp-github` and `mcp-GitHub` are one entry.
    const data = new Map<string, string>();
    const caseless: SecretStore = {
      storage: 'keychain',
      get: (name) => data.get(name.toLowerCase()) ?? null,
      set: (name, value) => void data.set(name.toLowerCase(), value),
      delete: (name) => void data.delete(name.toLowerCase()),
    };
    const lib = new ToolLibrary(db, caseless);
    lib.saveServer('github', { transport: 'stdio', command: 'x', env: [{ name: 'TOKEN', value: 'ghp_secret' }] });
    lib.saveServer('GitHub', { transport: 'stdio', command: 'x', env: [{ name: 'TOKEN' }], previousName: 'github' });
    // After a restart, the values are read back from the store.
    expect(new ToolLibrary(db, caseless).forAgent(agent('claude')).mcpServers).toMatchObject([{ name: 'GitHub', env: { TOKEN: 'ghp_secret' } }]);
  });

  it("keeps agents' exceptions when a server or a skill is renamed", () => {
    const dir = skill(join(root, 'renamed'), 'name: before');
    const lib = new ToolLibrary(db);
    lib.saveServer('old', { transport: 'stdio', command: 'x' });
    lib.update({ skills: [{ path: dir }] });
    const { id } = lib.view().mcpServers[0]!;
    const off = agent('claude', { [`mcp:${id}`]: false, [`skill:${dir}`]: false });
    lib.saveServer('new', { transport: 'stdio', command: 'x', previousName: 'old' });
    skill(dir, 'name: after');
    expect(lib.view().mcpServers[0]).toMatchObject({ id, name: 'new' });
    expect(lib.forAgent(off)).toMatchObject({ mcpServers: [], skills: [] });
    expect(lib.forAgent(agent('claude')).skills.map((s) => s.name)).toEqual(['after']);
    // A new server with an old name is a different server.
    lib.deleteServer('new');
    lib.saveServer('new', { transport: 'stdio', command: 'x' });
    expect(lib.forAgent(off).mcpServers.map((s) => s.name)).toEqual(['new']);
  });

  it('refuses duplicate names, unknown servers and a failing credential store', () => {
    const lib = new ToolLibrary(db, fakeKeyring());
    lib.saveServer('one', { transport: 'stdio', command: 'x' });
    expect(en(() => lib.saveServer('One', { transport: 'stdio', command: 'y' }))).toThrow(/already/);
    expect(en(() => lib.saveServer('two', { transport: 'stdio', command: 'y', previousName: 'nope' }))).toThrow(/No MCP server/);
    expect(en(() => lib.deleteServer('nope'))).toThrow(/No MCP server/);

    const broken: SecretStore = { ...fakeKeyring(), set: () => { throw new Error('locked'); } };
    const failing = new ToolLibrary(openDatabase(':memory:'), broken);
    expect(() => failing.saveServer('s', { transport: 'stdio', command: 'x', env: [{ name: 'K', value: 'v' }] })).toThrow(/locked/);
    expect(failing.view().mcpServers).toEqual([]);
  });

  it('keeps secrets in the database without a credential store, and moves them once there is one', () => {
    const plain = new ToolLibrary(db);
    plain.saveServer('s', { transport: 'stdio', command: 'x', env: [{ name: 'K', value: 'secret-value' }] });
    const id = idOf(plain, 's');
    expect(stored(db).secrets).toEqual({ [id]: { env: { K: 'secret-value' }, headers: {} } });
    const keyring = fakeKeyring();
    const lib = new ToolLibrary(db, keyring);
    expect(stored(db).secrets).toBeUndefined();
    expect(keyring.data.get(`mcp-${id}`)).toContain('secret-value');
    expect(lib.forAgent(agent('grok')).mcpServers[0]!.env).toEqual({ K: 'secret-value' });
    lib.deleteServer('s');
    expect(keyring.data.size).toBe(0);
  });

  it('keeps values in the database when moving them to the credential store fails', () => {
    const plain = new ToolLibrary(db);
    plain.saveServer('a', { transport: 'stdio', command: 'x', env: [{ name: 'A', value: 'value-a' }] });
    plain.saveServer('b', { transport: 'stdio', command: 'x', env: [{ name: 'B', value: 'value-b' }] });
    const [a, b] = [entry(plain, 'a'), idOf(plain, 'b')];
    const keyring = fakeKeyring();
    const refusing: SecretStore = {
      ...keyring,
      set: (name, value) => {
        if (name === `mcp-${b}`) throw new Error('locked');
        keyring.set(name, value);
      },
    };
    const lib = new ToolLibrary(db, refusing);
    lib.update({ memory: { all: 'any later save' } });
    expect(stored(db).secrets).toEqual({ [b]: { env: { B: 'value-b' }, headers: {} } });
    expect(keyring.data.get(a)).toContain('value-a');
    // The next start tries again and finds both.
    const again = new ToolLibrary(db, keyring);
    expect(again.forAgent(agent('claude')).mcpServers.map((s) => s.env)).toEqual([{ A: 'value-a' }, { B: 'value-b' }]);
    expect(stored(db).secrets).toBeUndefined();
  });

  it('never saves values it could not read over the real ones', () => {
    const keyring = fakeKeyring();
    const first = new ToolLibrary(db, keyring);
    first.saveServer('s', { transport: 'stdio', command: 'x', env: [{ name: 'K', value: 'real' }] });
    const name = entry(first, 's');
    const locked: SecretStore = { ...keyring, get: () => { throw new Error('locked'); } };
    const lib = new ToolLibrary(db, locked);
    expect(en(() => lib.saveServer('s', { transport: 'stdio', command: 'y', env: [{ name: 'K' }], previousName: 's' }))).toThrow(
      /could not be read/,
    );
    expect(keyring.data.get(name)).toContain('real');
    // Agents do not get a server started without its token.
    expect(lib.forAgent(agent('claude')).mcpServers).toEqual([]);
    lib.saveServer('s', { transport: 'stdio', command: 'y', env: [{ name: 'K', value: 'typed again' }], previousName: 's' });
    expect(keyring.data.get(name)).toContain('typed again');
  });

  it('reads values again once the credential store opens', () => {
    const keyring = fakeKeyring();
    new ToolLibrary(db, keyring).saveServer('s', { transport: 'stdio', command: 'x', env: [{ name: 'K', value: 'real' }] });
    let locked = true;
    const store: SecretStore = {
      ...keyring,
      get: (name) => {
        if (locked) throw new Error('locked');
        return keyring.get(name);
      },
    };
    const lib = new ToolLibrary(db, store);
    expect(lib.forAgent(agent('claude')).mcpServers).toEqual([]);
    locked = false;
    expect(lib.forAgent(agent('claude')).mcpServers.map((s) => s.env)).toEqual([{ K: 'real' }]);
  });

  it('gives items to the agents of their CLIs, with per-agent exceptions', () => {
    const skills = join(root, 'scoped');
    skill(join(skills, 'commit'), 'name: commit\ndescription: Commit well.');
    skill(join(skills, 'review'), 'name: review');
    const lib = new ToolLibrary(db);
    lib.saveServer('github', { transport: 'stdio', command: 'gh-mcp', providers: ['claude'] });
    lib.saveServer('off', { transport: 'stdio', command: 'off-mcp', providers: [] });
    lib.update({
      skills: [{ path: skills, providers: ['codex', 'grok'] }],
      memory: { all: 'Lead with the answer.', codex: 'Run npm test after edits.' },
    });

    const claude = lib.forAgent(agent('claude'));
    expect(claude.mcpServers.map((s) => s.name)).toEqual(['github']);
    expect(claude.skills).toEqual([]);
    expect(claude.memory).toBe('Lead with the answer.');

    const codex = lib.forAgent(agent('codex'));
    expect(codex.mcpServers).toEqual([]);
    expect(codex.skills.map((s) => [s.name, s.description, s.file])).toEqual([
      ['commit', 'Commit well.', join(skills, 'commit', 'SKILL.md')],
      ['review', '', join(skills, 'review', 'SKILL.md')],
    ]);
    expect(codex.memory).toBe('Lead with the answer.\n\nRun npm test after edits.');

    const id = (name: string) => lib.view().mcpServers.find((s) => s.name === name)!.id;
    const custom = lib.forAgent(
      agent('codex', {
        [`mcp:${id('off')}`]: true,
        [`mcp:${id('github')}`]: true,
        [`skill:${join(skills, 'review')}`]: false,
        memory: false,
        'memory:codex': true,
      }),
    );
    expect(custom.mcpServers.map((s) => s.name)).toEqual(['github', 'off']);
    expect(custom.skills.map((s) => s.name)).toEqual(['commit']);
    expect(custom.memory).toBe('Run npm test after edits.');
    expect(lib.forAgent(agent('grok', { memory: false })).memory).toBeUndefined();
  });

  it('checks new skill paths only, and marks skills it cannot use', () => {
    const dir = join(root, 'marks');
    const a = skill(join(dir, 'a'), 'name: same');
    const b = skill(join(dir, 'b'), 'name: same');
    const lib = new ToolLibrary(db);
    expect(en(() => lib.update({ skills: [{ path: join(dir, 'missing') }] }))).toThrow(/No skills/);
    lib.update({ skills: [{ path: a }, { path: b }, { path: a }] });
    rmSync(join(a, 'SKILL.md'));
    const view = lib.view().skills;
    expect(view.map((s) => [s.name, Boolean(s.problem)])).toEqual([
      ['a', true],
      ['same', false],
    ]);
    // A known path stays even though its SKILL.md is gone; agents just do not get it.
    lib.update({ skills: view.map((s) => ({ path: s.path, providers: s.providers })) });
    expect(lib.forAgent(agent('claude')).skills.map((s) => s.dir)).toEqual([b]);
  });

  it('offers the skills under a folder with their names, marking the ones already added', () => {
    const dir = join(root, 'offer');
    const one = skill(join(dir, 'one'), 'name: first\ndescription: >-\n  Does the\n  first thing.');
    const two = skill(join(dir, 'two'), 'description: no name');
    const lib = new ToolLibrary(db);
    lib.update({ skills: [{ path: one }] });
    expect(lib.scanSkills(dir)).toEqual([
      { path: one, name: 'first', description: 'Does the first thing.', added: true },
      { path: two, name: 'two', description: 'no name', added: false },
    ]);
    expect(lib.view().skills).toHaveLength(1);
  });

  it('reads data saved before items had CLIs', () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('tool_library', ?)").run(
      JSON.stringify({
        mcpServers: [{ name: 'x', transport: 'stdio', command: 'x', args: [], url: '', env: [], headers: [], enabled: false }],
        skills: [{ path: '/nowhere', enabled: true }],
        memory: 'old notes',
      }),
    );
    const view = new ToolLibrary(db).view();
    expect(view.mcpServers[0]!.providers).toEqual([]);
    expect(view.skills[0]!.providers).toEqual(PROVIDERS);
    expect(view.memory).toEqual({ all: 'old notes', claude: '', codex: '', grok: '', cursor: '', opencode: '', goose: '', cline: '', openhands: '', pi: '' });
  });
});
