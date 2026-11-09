import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { dosDateTime, safeName, zipStream } from '../src/server/zip';
import { collect, readZip } from './zipReader';

const dir = mkdtempSync(join(tmpdir(), 'relay-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('zipStream', () => {
  it('writes folders and files an unzip tool reads back, with UTF-8 names', async () => {
    const big = randomBytes(300_000); // several deflate blocks, and not compressible
    const text = 'hello\n'.repeat(5000);
    writeFileSync(join(dir, 'big.bin'), big);
    writeFileSync(join(dir, 'notes.md'), text);
    writeFileSync(join(dir, 'empty.txt'), '');
    const mtime = new Date(2026, 0, 5, 8, 30, 41).getTime();
    const zip = await collect(
      zipStream([
        { name: 'project/', mtime },
        { name: 'project/報告.md', mtime, source: join(dir, 'notes.md') },
        { name: 'project/data/', mtime },
        { name: 'project/data/big.bin', mtime, source: join(dir, 'big.bin') },
        { name: 'project/empty.txt', mtime, source: join(dir, 'empty.txt') },
        { name: 'project/gone.txt', mtime, source: join(dir, 'missing.txt') }, // left out: cannot be opened
        { name: 'project/stream.txt', mtime, source: () => Readable.from([Buffer.from('a'), Buffer.from('b')]) },
      ]),
    );
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'project/',
      'project/報告.md',
      'project/data/',
      'project/data/big.bin',
      'project/empty.txt',
      'project/stream.txt',
    ]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['project/報告.md']!.data.toString()).toBe(text);
    expect(byName['project/data/big.bin']!.data.equals(big)).toBe(true);
    expect(byName['project/empty.txt']!.data.length).toBe(0);
    expect(byName['project/stream.txt']!.data.toString()).toBe('ab');
    // Every name is marked UTF-8; files are deflated with a data descriptor, folders stored.
    expect(entries.every((e) => e.flags & 0x800)).toBe(true);
    expect(byName['project/報告.md']).toMatchObject({ method: 8, flags: 0x808 });
    expect(byName['project/data/']).toMatchObject({ method: 0, flags: 0x800 });
    // Unix modes: a folder and a plain file.
    expect(byName['project/data/']!.attributes >>> 16).toBe(0o40755);
    expect(byName['project/報告.md']!.attributes >>> 16).toBe(0o100644);
    // Text compresses.
    expect(zip.length).toBeLessThan(big.length + text.length / 10);
    expect(byName['project/報告.md']!.time).toBe(dosDateTime(mtime).time);
  });

  it('writes an empty archive', async () => {
    expect(readZip(await collect(zipStream([])))).toEqual([]);
  });

  it('ends the archive with the error when a file fails while it is read', async () => {
    const failing = () =>
      new Readable({
        read() {
          this.destroy(new Error('disk gone'));
        },
      });
    await expect(collect(zipStream([{ name: 'x', mtime: 0, source: failing }]))).rejects.toThrow('disk gone');
  });

  it('closes the file when the download stops right after its header', async () => {
    let destroyed = false;
    const source = () =>
      new Readable({
        read() {
          this.push('x');
        },
        destroy(err, done) {
          destroyed = true;
          done(err);
        },
      });
    const zip = zipStream([{ name: 'x', mtime: 0, source }]);
    expect((await zip.next()).value!.readUInt32LE(0)).toBe(0x04034b50); // the header
    await zip.return(undefined);
    expect(destroyed).toBe(true);
  });

  it('closes the file it reads when the download stops', async () => {
    let destroyed = false;
    const endless = () =>
      new Readable({
        read() {
          this.push(randomBytes(64 * 1024));
        },
        destroy(err, done) {
          destroyed = true;
          done(err);
        },
      });
    const zip = zipStream([{ name: 'x', mtime: 0, source: endless }]);
    let n = 0;
    for await (const _ of zip) if (++n > 3) break;
    expect(destroyed).toBe(true);
  });
});

describe('names and permissions', () => {
  it('makes names every unzip tool keeps inside its folder', () => {
    expect(safeName('top/..\\..\\evil.txt')).toBe('top/.._.._evil.txt');
    expect(safeName('top/../x')).toBe('top/_/x');
    expect(safeName('/etc/passwd')).toBe('etc/passwd');
    expect(safeName('top/C:x.txt')).toBe('top/C_x.txt');
    expect(safeName('top/a\u0001b')).toBe('top/a_b');
    expect(safeName('top/報告 (1).md')).toBe('top/報告 (1).md');
    expect(safeName('top/dir/')).toBe('top/dir/');
  });

  it('writes safe names and the permission bits it is given', async () => {
    const entries = readZip(
      await collect(
        zipStream([
          { name: 'top/..\\..\\evil.txt', mtime: 0, source: () => Readable.from([Buffer.from('e')]) },
          { name: 'top/run.sh', mtime: 0, mode: 0o100755, source: () => Readable.from([Buffer.from('#!/bin/sh')]) },
          { name: 'top/private/', mtime: 0, mode: 0o40700 },
        ]),
      ),
    );
    expect(entries.map((e) => e.name)).toEqual(['top/.._.._evil.txt', 'top/run.sh', 'top/private/']);
    expect(entries.map((e) => e.attributes >>> 16)).toEqual([0o100644, 0o100755, 0o40700]);
  });
});

describe('dosDateTime', () => {
  it('keeps local time in 2-second steps, from 1980', () => {
    const { time, date } = dosDateTime(new Date(2026, 10, 9, 21, 5, 59).getTime());
    expect([date >> 9, (date >> 5) & 0xf, date & 0x1f]).toEqual([2026 - 1980, 11, 9]);
    expect([time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2]).toEqual([21, 5, 58]);
    expect(dosDateTime(new Date(1970, 0, 1).getTime())).toEqual(dosDateTime(new Date(1980, 0, 1).getTime()));
    expect(dosDateTime(NaN)).toEqual(dosDateTime(new Date(1980, 0, 1).getTime()));
  });
});
