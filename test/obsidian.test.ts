import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteWriteTools, selectedVault, vaultInventory } from '../src/server/connectors/obsidian';
import { openDatabase, withholdFile } from '../src/server/db';
import { ToolGateway, type GatewayContext } from '../src/server/gateway';
import { withLang } from '../src/server/i18n';
import { Outbox } from '../src/server/outbox';
import { Store } from '../src/server/store';
import { ToolLibrary } from '../src/server/tools';
import type { Conversation, Permission } from '../src/shared/types';

describe('Obsidian note proposals', () => {
  let root: string;
  let vault: string;
  let selected: string;
  let db: ReturnType<typeof openDatabase>;
  let outbox: Outbox;
  let gateway: ToolGateway;
  const convId = 'notes';
  const context = (permission: Permission): GatewayContext => ({
    convId,
    messageId: 'm',
    agentId: 'a',
    agentName: 'Alice',
    permission,
    cwd: root,
    unattended: true,
    signal: new AbortController().signal,
    toOutbox: ({ args, ...preview }) => outbox.add({ ...preview, convId, messageId: 'm', agentId: 'a', agentName: 'Alice' }, args).item,
  });
  const propose = (op: 'create' | 'edit', path: string, content: unknown, permission: Permission = 'full') =>
    withLang('en', () => gateway.call(gateway.tool(`obsidian_${op}`)!, { path, content }, context(permission)));
  const answer = (id: string, action: 'send' | 'discard' = 'send') =>
    withLang('en', () => outbox.answer(convId, id, action, (name) => gateway.tool(name)));
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relay-note-')));
    selected = vault = join(root, 'vault');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    mkdirSync(join(vault, 'Notes'));
    db = openDatabase(':memory:');
    new Store(db).create({
      id: convId,
      title: 'Notes',
      createdAt: 0,
      updatedAt: 0,
      agents: [],
      settings: { mode: 'roundtable', rounds: 1, maxHops: 1, permission: 'full', cwd: root, approvals: 'ask' },
      messages: [],
      agentState: {},
      worktrees: {},
    } as Conversation);
    outbox = new Outbox(db);
    gateway = new ToolGateway(root, join(root, 'tmp'), () => process.execPath);
    gateway.register(
      noteWriteTools(
        (id) => selectedVault(selected ? [{ id: 'one', path: selected }] : [], id, {}),
        () => (selected ? undefined : 'No vault'),
      ),
    );
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('only queues at every permission, keeps the full preview across restart and writes once on explicit confirmation', async () => {
    const path = 'Notes/會議.md';
    const full = join(vault, path);
    const content = '\uFEFF# 明天\r\n\r\n- tea 🍵\r\n';
    for (const permission of ['full', 'read-only', 'edit'] as const) {
      expect((await propose('create', path, content, permission)).text).toContain('No note has been written');
      expect(existsSync(full)).toBe(false);
      expect(readdirSync(join(vault, 'Notes'))).toEqual([]);
    }
    expect(outbox.waiting(convId)).toBe(1);
    outbox = new Outbox(db);
    const item = outbox.list(convId)[0];
    expect(item.preview.note).toEqual({ vault, path, before: null, after: content });
    await expect(outbox.answer('other', item.id, 'send', (name) => gateway.tool(name))).rejects.toMatchObject({ status: 404 });
    expect((await answer(item.id)).status).toBe('sent');
    expect(readFileSync(full, 'utf8')).toBe(content);
    await expect(answer(item.id)).rejects.toMatchObject({ status: 409 });
    await propose('edit', path, '');
    const edit = outbox.list(convId).at(-1)!;
    expect(edit.preview.note).toEqual({ vault, path, before: content, after: '' });
    expect((await answer(edit.id)).status).toBe('sent');
    expect(readFileSync(full).length).toBe(0);
    await propose('edit', path, 'discard me');
    const discarded = outbox.list(convId).at(-1)!;
    expect(discarded.preview.note?.before).toBe('');
    expect((await answer(discarded.id, 'discard')).status).toBe('discarded');
    expect(readFileSync(full).length).toBe(0);
  });

  it.skipIf(process.platform !== 'darwin')(
    'preserves macOS extended attributes and access control entries when replacing the note',
    async () => {
      const path = 'Tagged.md',
        full = join(vault, path);
      writeFileSync(full, 'old');
      execFileSync('/usr/bin/xattr', ['-w', 'com.example.relay-tag', 'blue', full]);
      execFileSync('/bin/chmod', ['+a', 'everyone allow readattr', full]);
      await propose('edit', path, 'new');
      expect((await answer(outbox.list(convId)[0].id)).status).toBe('sent');
      expect(readFileSync(full, 'utf8')).toBe('new');
      expect(execFileSync('/usr/bin/xattr', ['-p', 'com.example.relay-tag', full], { encoding: 'utf8' }).trim()).toBe('blue');
      expect(execFileSync('/bin/ls', ['-le', full], { encoding: 'utf8' })).toContain('allow readattr');
    },
  );

  it('refuses a create collision and a changed original, including an identical replacement at the same path', async () => {
    const path = 'Note.md',
      full = join(vault, path);
    await propose('create', path, 'pending');
    writeFileSync(full, 'new arrival');
    expect((await answer(outbox.list(convId)[0].id)).status).toBe('failed');
    expect(readFileSync(full, 'utf8')).toBe('new arrival');
    expect((await propose('create', path, 'replace it')).isError).toBe(true);
    const changes = ['external edit', 'identical replacement'];
    for (const change of changes) {
      const before = readFileSync(full, 'utf8');
      await propose('edit', path, 'overwrite');
      if (change === 'external edit') writeFileSync(full, change);
      else {
        renameSync(full, full + '.old');
        writeFileSync(full, before);
      }
      expect((await answer(outbox.list(convId).at(-1)!.id)).status).toBe('failed');
      expect(readFileSync(full, 'utf8')).toBe(change === 'external edit' ? change : before);
    }
    await Promise.all([propose('edit', path, 'one'), propose('edit', path, 'two')]);
    const [a, b] = outbox.list(convId).slice(-2);
    const done = await Promise.all([answer(a.id), answer(b.id)]);
    expect(done.map((x) => x.status)).toEqual(['sent', 'failed']);
    expect(readFileSync(full, 'utf8')).toBe(a.preview.note!.after);
  });

  it('pins the selected vault and parent and refuses a disconnected vault', async () => {
    const path = 'Notes/Test.md';
    await propose('create', path, 'initial');
    selected = join(root, 'another');
    mkdirSync(join(selected, '.obsidian'), { recursive: true });
    mkdirSync(join(selected, 'Notes'));
    expect((await answer(outbox.list(convId)[0].id)).status).toBe('failed');
    expect(existsSync(join(selected, path))).toBe(false);
    expect(existsSync(join(vault, path))).toBe(false);
    selected = vault;
    await propose('create', path, 'new');
    renameSync(join(vault, 'Notes'), join(vault, 'previous'));
    mkdirSync(join(vault, 'Notes'));
    expect((await answer(outbox.list(convId).at(-1)!.id)).status).toBe('failed');
    await propose('create', path, 'new again');
    selected = '';
    expect((await answer(outbox.list(convId).at(-1)!.id)).status).toBe('failed');
    expect((await propose('create', path, '')).isError).toBe(true);
    expect(existsSync(join(vault, path))).toBe(false);
  });

  it('keeps the vault and its preview across server restarts and invalidates the preview after reconnection', async () => {
    let library = new ToolLibrary(db);
    library.setObsidianVault(vault);
    const selection = library.obsidianVaults()[0].id;
    expect(selection).toBeTruthy();
    gateway.register(
      noteWriteTools(
        (id) => selectedVault(library.obsidianVaults(), id, {}),
        () => (library.obsidianVaults().length ? undefined : 'No vault'),
      ),
    );
    const path = 'Reconnect.md';
    await propose('create', path, 'initial');
    library = new ToolLibrary(db);
    expect(library.obsidianVaults()[0].path).toBe(vault);
    expect(library.obsidianVaults()[0].id).toBe(selection);
    library.setObsidianVault(vault);
    expect((await answer(outbox.list(convId)[0].id)).status).toBe('sent');

    await propose('edit', path, 'old proposal');
    library.setObsidianVault('');
    library = new ToolLibrary(db);
    expect(library.obsidianVaults()).toEqual([]);
    library.setObsidianVault(vault);
    expect(library.obsidianVaults()[0].id).not.toBe(selection);
    expect((await answer(outbox.list(convId).at(-1)!.id)).status).toBe('failed');
    expect(readFileSync(join(vault, path), 'utf8')).toBe('initial');
    expect(library.forAgent({ provider: 'codex' }).relayGroups).not.toContain('obsidian');
  });

  it('paginates large vault inventories with the canonical path and ID intact', () => {
    const entries = Array.from({ length: 35 }, (_, i) => {
      const path = join(root, 'library', String(i), 'My Vault');
      mkdirSync(join(path, '.obsidian'), { recursive: true });
      return { id: String(i), path };
    });
    const first = JSON.parse(vaultInventory(entries, undefined, {}));
    const last = JSON.parse(vaultInventory(entries, first.nextOffset, {}));
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(last.nextOffset).toBeUndefined();
    expect([...first.vaults, ...last.vaults]).toEqual(entries.map((v) => ({ ...v, available: true })));
    expect(() => vaultInventory(entries, '2', {})).toThrow();
    expect(() => vaultInventory(entries, -1, {})).toThrow();
  });

  it.each(['previous-vault-id', ''])(
    'keeps the original single-vault selection and its pending write across migration (%j)',
    async (oldId) => {
      db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run(
        'tool_library',
        JSON.stringify({
          obsidianVault: vault,
          ...(oldId ? { obsidianVaultId: oldId } : {}),
        }),
      );
      let library = new ToolLibrary(db);
      expect(library.obsidianVaults()).toEqual([{ id: oldId || 'legacy', path: vault }]);
      gateway.register(
        noteWriteTools(
          (id) => selectedVault(library.obsidianVaults(), id, {}),
          () => undefined,
        ),
      );
      const path = 'Before migration.md';
      await propose('create', path, 'approved text');
      await propose('create', 'Stale.md', 'old write');
      const [item, stale] = outbox.list(convId);
      // The old prepare() stored an empty vaultId when the original single selection had no ID.
      for (const pending of [item, stale]) {
        const row = db.prepare('SELECT args FROM outbox WHERE id=?').get(pending.id) as { args: string };
        db.prepare('UPDATE outbox SET args=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.args), vaultId: oldId }), pending.id);
      }
      const second = join(root, 'second');
      mkdirSync(join(second, '.obsidian'), { recursive: true });
      library.addObsidianVaults([second]);
      library = new ToolLibrary(db);
      expect(library.obsidianVaults()[0].id).toBe(oldId || 'legacy');
      expect((await answer(item.id)).status).toBe('sent');
      expect(readFileSync(join(vault, path), 'utf8')).toBe('approved text');
      expect(existsSync(join(second, path))).toBe(false);
      library.removeObsidianVault(oldId || 'legacy');
      library.addObsidianVaults([vault]);
      expect((await answer(stale.id)).status).toBe('failed');
      expect(existsSync(join(vault, 'Stale.md'))).toBe(false);
    },
  );

  it('pins each write to its vault and keeps other pending proposals valid when one vault is removed and added back', async () => {
    let library = new ToolLibrary(db);
    const second = join(root, 'another', 'vault');
    mkdirSync(join(second, '.obsidian'), { recursive: true });
    library.addObsidianVaults([vault, second]);
    const [one, two] = library.obsidianVaults();
    gateway.register(
      noteWriteTools(
        (id) => selectedVault(library.obsidianVaults(), id, {}),
        () => undefined,
      ),
    );
    const path = 'Same name.md';
    for (const root of [vault, second]) writeFileSync(join(root, path), 'original');
    for (const op of ['create', 'edit'] as const) {
      const tool = gateway.tool('obsidian_' + op)!;
      for (const invalid of [undefined, 'wrong', 'vault', vault, null]) {
        const result = await gateway.call(tool, { vault: invalid, path, content: 'original' }, context('full'));
        expect(result.isError).toBe(true);
      }
      for (const selection of [one, two]) {
        const target = op === 'edit' ? path : 'New.md';
        const result = await gateway.call(tool, { vault: selection.id, path: target, content: 'approved' }, context('full'));
        expect(result.isError).toBeFalsy();
      }
    }
    const items = outbox.list(convId);
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.preview.note!.vault)).toEqual([vault, second, vault, second]);
    library.removeObsidianVault(one.id);
    library.addObsidianVaults([vault]);
    library = new ToolLibrary(db);
    for (const item of items) {
      const stillConnected = item.preview.note!.vault === second;
      const result = await answer(item.id);
      expect(result.status).toBe(stillConnected ? 'sent' : 'failed');
      if (!stillConnected) expect(result.result).toContain('fresh preview');
    }
    expect(readFileSync(join(vault, path), 'utf8')).toBe('original');
    expect(existsSync(join(vault, 'New.md'))).toBe(false);
    expect(readFileSync(join(second, path), 'utf8')).toBe('approved');
    expect(readFileSync(join(second, 'New.md'), 'utf8')).toBe('approved');
    expect(library.obsidianVaults().find((v) => v.path === second)?.id).toBe(two.id);
  });

  it('refuses new or pending writes into a nested vault', async () => {
    const nested = join(vault, 'Notes');
    writeFileSync(join(nested, 'Edit.md'), 'original');
    await propose('edit', 'Notes/Edit.md', 'preview');
    await propose('create', 'Notes/New.md', 'preview');
    mkdirSync(join(nested, '.obsidian'));
    for (const item of outbox.list(convId)) expect((await answer(item.id)).status).toBe('failed');
    expect((await propose('edit', 'Notes/Edit.md', 'new')).isError).toBe(true);
    expect((await propose('create', 'Notes/New.md', 'new')).isError).toBe(true);
    expect(readFileSync(join(nested, 'Edit.md'), 'utf8')).toBe('original');
    expect(existsSync(join(nested, 'New.md'))).toBe(false);
  });

  it('rejects hidden, non-Markdown, ambiguous and missing parent paths, withheld files, binary or oversized contents', async () => {
    for (const path of [
      '.obsidian/secret.md',
      '../escaped.md',
      '/absolute.md',
      'A//B.md',
      'Note.txt',
      'x\\y.md',
      'name:stream.md',
      'CON.md',
      'Missing/Note.md',
    ]) {
      expect((await propose('create', path, 'x')).isError, path).toBe(true);
    }
    const path = 'File.md',
      full = join(vault, path);
    for (const text of [null, 'bad\0byte', '\udfff', '台'.repeat(16385)]) {
      expect((await propose('create', path, text)).isError).toBe(true);
    }
    for (const bytes of [Buffer.from([0xff]), Buffer.from([65, 0]), Buffer.alloc(48 * 1024 + 1, 65)]) {
      writeFileSync(full, bytes);
      expect((await propose('edit', path, 'new')).isError).toBe(true);
    }
    writeFileSync(full, 'regular note');
    withholdFile(full);
    expect((await propose('edit', path, 'new')).isError).toBe(true);
    expect(outbox.waiting(convId)).toBe(0);
    expect(readFileSync(full, 'utf8')).toBe('regular note');
  });

  it('rejects hard-linked notes, including a link introduced after the preview', async () => {
    const path = 'Original.md',
      full = join(vault, path),
      other = join(root, 'other');
    writeFileSync(full, 'original');
    await propose('edit', path, 'update');
    linkSync(full, other);
    expect((await propose('edit', path, 'new')).isError).toBe(true);
    expect((await answer(outbox.list(convId)[0].id)).status).toBe('failed');
    expect(readFileSync(other, 'utf8')).toBe('original');
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic links and a replaced parent at confirmation', async () => {
    const path = 'Notes/Note.md';
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'Note.md'), 'outside');
    writeFileSync(join(vault, path), 'old');
    await propose('edit', path, 'update');
    renameSync(join(vault, 'Notes'), join(vault, 'original'));
    symlinkSync(outside, join(vault, 'Notes'), 'dir');
    expect((await answer(outbox.list(convId)[0].id)).status).toBe('failed');
    expect((await propose('create', 'Notes/New.md', 'new')).isError).toBe(true);
    symlinkSync(join(outside, 'absent'), join(vault, 'Dangling.md'));
    expect((await propose('create', 'Dangling.md', 'new')).isError).toBe(true);
    expect(readFileSync(join(outside, 'Note.md'), 'utf8')).toBe('outside');
  });
});
