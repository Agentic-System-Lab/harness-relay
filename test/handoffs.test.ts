/*
 * Secrets and fixed commands, their pure parts and their store: the reply blocks (`src/shared/handoffs.ts`:
 * what is taken and what stays text), masking, the cards' logic (`src/web/handoffs.ts`) and
 * `HandoffStore` (`src/server/handoffs.ts`: names in the database, values in the credential store only).
 */
import { describe, expect, it } from 'vitest';
import { HANDOFF_LIMITS, type FixedCommandRun } from '../src/shared/types';
import {
  checkProposal,
  commandFolder,
  hostName,
  maskValues,
  secretName,
  secretValueProblem,
  splitHandoffs,
  withoutHandoffBlocks,
} from '../src/shared/handoffs';
import { commandActions, filledValues, formOf, proposalOf, runTone, wordsOf, type CommandPart } from '../src/web/handoffs';
import { openDatabase } from '../src/server/db';
import { HandoffStore, secretEntry } from '../src/server/handoffs';
import type { SecretStore } from '../src/server/secrets';
import { withLang } from '../src/server/i18n';

describe('hand-off blocks in a reply', () => {
  it('takes secrets, commands and runs on lines of their own, in order, and keeps the rest of the text', () => {
    const text = [
      'I need a token and a script.',
      '',
      '<secret name="threads_access_token" label="Threads access token">From the User Token Generator.</secret>',
      '<command name="Post" hosts="graph.threads.net, graph.facebook.com" secrets="THREADS_ACCESS_TOKEN">python3 post.py</command>',
      '<command-run name="post">',
      'Hello, Threads!',
      '</command-run>',
      '',
      'Save them, then try it.',
    ].join('\n');
    const { text: rest, blocks } = splitHandoffs(text);
    expect(rest).toBe('I need a token and a script.\n\nSave them, then try it.');
    expect(blocks).toEqual([
      { kind: 'secret', name: 'THREADS_ACCESS_TOKEN', label: 'Threads access token', reason: 'From the User Token Generator.' },
      {
        kind: 'command',
        name: 'post',
        run: 'python3 post.py',
        hosts: ['graph.threads.net', 'graph.facebook.com'],
        secrets: ['THREADS_ACCESS_TOKEN'],
      },
      { kind: 'command-run', name: 'post', input: 'Hello, Threads!' },
    ]);
  });

  it('takes a self-closing secret and a command with a folder, and several blocks on one line', () => {
    const { blocks, text } = splitHandoffs('<secret name="A_KEY"/> <secret name="B_KEY" />\n<command name="sync" cwd="./bot/">./run.sh</command>');
    expect(text).toBe('');
    expect(blocks).toEqual([
      { kind: 'secret', name: 'A_KEY' },
      { kind: 'secret', name: 'B_KEY' },
      { kind: 'command', name: 'sync', run: './run.sh', hosts: [], secrets: [], cwd: 'bot' },
    ]);
  });

  it('leaves examples in code, blocks inside a sentence, and invalid blocks as text', () => {
    const cases = [
      '```\n<secret name="X_KEY">why</secret>\n```',
      'Use <secret name="X_KEY">why</secret> like this.',
      '    <secret name="X_KEY">indented code</secret>',
      '<secret name="9BAD">a name starting with a digit</secret>',
      '<command name="post" hosts="https://graph.threads.net/v1">python3 post.py</command>',
      '<command name="post" cwd="../elsewhere">python3 post.py</command>',
      '<command name="post"></command>',
      '<command name="post">python3 post.py',
      '<secret name="A_KEY">unfinished <secret name="B_KEY">x</secret>',
    ];
    for (const text of cases) expect(splitHandoffs(text), text).toEqual({ text, blocks: [] });
  });

  it('refuses a block that runs across a fence or is too long', () => {
    const across = '<command name="post">python3 post.py\n```\n</command>';
    expect(splitHandoffs(across).blocks).toEqual([]);
    const long = `<command name="post">${'x'.repeat(HANDOFF_LIMITS.commandLine + 1)}</command>`;
    expect(splitHandoffs(long).blocks).toEqual([]);
  });

  it('hides blocks while a reply streams: finished ones taken out, one still being written from its tag on', () => {
    expect(withoutHandoffBlocks('Here:\n<secret name="A_KEY">why</secret>\nDone.')).toBe('Here:\nDone.');
    expect(withoutHandoffBlocks('Here:\n<command name="post" hosts="a.com">python3 po')).toBe('Here:');
    expect(withoutHandoffBlocks('No blocks <here>.')).toBe('No blocks <here>.');
  });

  it('checks names, hosts, folders and values', () => {
    expect(secretName('api_key')).toBe('API_KEY');
    expect(secretName('my-key')).toBeUndefined();
    expect(hostName('API.Example.com:8443')).toBe('api.example.com:8443');
    expect(hostName('[::1]:80')).toBe('[::1]:80');
    expect(hostName('example.com:0')).toBeUndefined();
    expect(hostName('example.com/path')).toBeUndefined();
    expect(commandFolder(undefined)).toBe('');
    expect(commandFolder('a\\b')).toBe('a/b');
    expect(commandFolder('/abs')).toBeUndefined();
    expect(commandFolder('C:/x')).toBeUndefined();
    expect(commandFolder('a/.git/hooks')).toBeUndefined();
    expect(secretValueProblem('  ')).toBe('empty');
    expect(secretValueProblem('a\nb')).toBe('lines');
    expect(secretValueProblem('x'.repeat(HANDOFF_LIMITS.secretValue + 1))).toBe('long');
    expect(secretValueProblem(' tok-123 ')).toBeUndefined();
    expect(checkProposal({ name: 'post', run: '  ', hosts: [] })).toBeUndefined();
    expect(checkProposal({ name: 'post', run: 'x', hosts: Array.from({ length: 11 }, (_, i) => `h${i}.com`) })).toBeUndefined();
    expect(checkProposal({ name: 'post', run: 'x', hosts: ['a.com', 'A.com'], secrets: ['k', 'K'] })).toEqual({
      name: 'post',
      run: 'x',
      hosts: ['a.com'],
      secrets: ['K'],
    });
  });

  it('masks every value, the longest first, and leaves values too short to mask safely', () => {
    expect(maskValues('token=abcd1234 and abcd1234xyz, key=ab', ['abcd1234', 'abcd1234xyz', 'ab'])).toBe(
      'token=•••• and ••••, key=ab',
    );
  });
});

describe("the cards' logic", () => {
  const part = (over: Partial<CommandPart> = {}): CommandPart => ({
    type: 'command',
    id: 'p1',
    folder: '/w',
    proposal: { name: 'post', run: 'python3 post.py', hosts: ['a.com'], secrets: ['K'] },
    status: 'proposed',
    ...over,
  });
  const run = (status: FixedCommandRun['status']): FixedCommandRun => ({ at: 1, source: 'try', status });

  it('turns what the user typed into what the server takes', () => {
    expect(wordsOf('a.com, b.com，c.com  a.com')).toEqual(['a.com', 'b.com', 'c.com']);
    expect(filledValues([{ name: 'A', status: 'waiting' }, { name: 'B', status: 'waiting' }], { A: ' x ', B: ' ' })).toEqual({ A: 'x' });
    const form = formOf(part().proposal);
    expect(form).toEqual({ name: 'post', run: 'python3 post.py', hosts: 'a.com', secrets: 'K', cwd: '' });
    expect(proposalOf({ ...form, hosts: 'a.com b.com', cwd: 'bot' })).toEqual({
      name: 'post',
      run: 'python3 post.py',
      hosts: ['a.com', 'b.com'],
      secrets: ['K'],
      cwd: 'bot',
    });
    expect(proposalOf({ ...form, name: 'Bad Name' })).toBeUndefined();
  });

  it('offers what fits the card: decide, try, approve changes, share a result', () => {
    expect(commandActions(part())).toEqual({ decide: true, tryIt: false, approve: false, share: false });
    const saved = part({ status: 'saved', commandId: 'c1' });
    expect(commandActions(saved)).toEqual({ decide: false, tryIt: true, approve: false, share: false });
    expect(commandActions({ ...saved, run: run('running') })).toMatchObject({ tryIt: false, share: false });
    expect(commandActions({ ...saved, run: run('changed') })).toMatchObject({ approve: true, share: false });
    expect(commandActions({ ...saved, run: run('failed') })).toMatchObject({ tryIt: true, share: true });
    expect(commandActions(part({ status: 'dismissed' }))).toEqual({ decide: false, tryIt: false, approve: false, share: false });
    expect(runTone(run('news'))).toEqual({ tone: 'ok', code: true });
    expect(runTone(run('error'))).toEqual({ tone: 'bad', code: false });
  });
});

describe('the store of secrets and fixed commands', () => {
  const make = (withKeyring = true) => {
    const db = openDatabase(':memory:');
    const values = new Map<string, string>();
    const keyring: SecretStore = {
      storage: 'keychain',
      get: (k) => values.get(k) ?? null,
      set: (k, v) => void values.set(k, v),
      delete: (k) => void values.delete(k),
    };
    return { db, values, store: new HandoffStore(db, withKeyring ? keyring : undefined) };
  };
  const pin = { manifest: {} };

  it('keeps values in the credential store, one entry a folder, and only names and times in the database', () => {
    const { db, values, store } = make();
    store.setSecrets('/w', { TOKEN: ' tok-123 ', APP_SECRET: 'sec-456' });
    expect(store.values('/w')).toEqual({ TOKEN: 'tok-123', APP_SECRET: 'sec-456' });
    expect([...values.keys()]).toEqual([secretEntry('/w')]);
    expect(secretEntry('/w')).not.toContain('/w');
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'handoffs'").get() as { value: string };
    expect(row.value).not.toContain('tok-123');
    expect(row.value).not.toContain('sec-456');
    expect(store.secretNames('/w').map((s) => s.name)).toEqual(['TOKEN', 'APP_SECRET']);
    // Another store on the same database finds the names, and the values through the keyring.
    expect(new HandoffStore(db).secretNames('/w')).toHaveLength(2);
    store.deleteSecret('/w', 'TOKEN');
    expect(store.values('/w')).toEqual({ APP_SECRET: 'sec-456' });
    store.deleteSecret('/w', 'APP_SECRET');
    expect(values.size).toBe(0);
    expect(store.folders()).toEqual([]);
  });

  it('refuses bad names and values, too many secrets, and works with no credential store only to say so', () => {
    const { store } = make();
    withLang('en', () => {
      expect(() => store.setSecrets('/w', { 'bad-name': 'x' })).toThrow(/not a valid secret name/);
      expect(() => store.setSecrets('/w', { GOOD: 'a\nb' })).toThrow(/line breaks/);
      const many = Object.fromEntries(Array.from({ length: HANDOFF_LIMITS.secretsPerFolder + 1 }, (_, i) => [`K${i}`, 'v']));
      expect(() => store.setSecrets('/w', many)).toThrow(/at most/);
      expect(store.folders()).toEqual([]);
      const { store: bare } = make(false);
      expect(bare.storage).toBe(false);
      expect(() => bare.setSecrets('/w', { K: 'v' })).toThrow(/no credential store/);
    });
  });

  it('saves a command by name (a namesake replaced, keeping its id), its pin and last run, and removes it', () => {
    const { db, store } = make();
    const id = store.commandId('/w', 'post');
    const saved = store.saveCommand('/w', id, { name: 'post', run: 'python3 post.py', hosts: ['a.com'], secrets: ['K'] }, pin);
    expect(saved).toMatchObject({ id, folder: '/w', name: 'post' });
    expect(store.commandId('/w', 'post')).toBe(id);
    store.saveCommand('/w', id, { name: 'post', run: 'python3 post.py --v2', hosts: [], secrets: [] }, { manifest: { 'post.py': { kind: 'file' } } });
    expect(store.commands('/w')).toHaveLength(1);
    expect(store.command(id)!.run).toBe('python3 post.py --v2');
    expect(store.pin(id)!.manifest).toHaveProperty(['post.py']);
    store.setLastRun(id, { at: 5, source: 'try', status: 'running' });
    // A run the server stopped during is not running after a restart.
    expect(new HandoffStore(db).command(id)!.lastRun!.status).toBe('error');
    expect(store.commandByName('/w', 'post')!.id).toBe(id);
    const { pin: dropped } = store.deleteCommand(id);
    expect(dropped).toBeDefined();
    expect(store.command(id)).toBeUndefined();
    expect(store.pin(id)).toBeUndefined();
    expect(() => withLang('en', () => store.deleteCommand(id))).toThrow(/not found/);
  });

  it('keeps at most so many commands a folder', () => {
    const { store } = make();
    for (let i = 0; i < HANDOFF_LIMITS.commandsPerFolder; i++) {
      store.saveCommand('/w', store.commandId('/w', `c${i}`), { name: `c${i}`, run: 'true', hosts: [], secrets: [] }, pin);
    }
    expect(() => withLang('en', () => store.commandId('/w', 'one-more'))).toThrow(/at most/);
    // A namesake still replaces.
    expect(store.commandId('/w', 'c0')).toBe(store.commandByName('/w', 'c0')!.id);
  });
});
