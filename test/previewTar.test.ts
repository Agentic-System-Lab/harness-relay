import { expect, it } from 'vitest';
import { tarFiles } from '../src/server/previewTar';

/** Reads a tar archive back: names (a pax path wins), modes and bytes, checking each header's checksum. */
function untar(archive: Buffer) {
  const out: { name: string; mode: number; data: Buffer }[] = [];
  let at = 0;
  let paxName: string | undefined;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, size: number) => header.toString('latin1', start, start + size).replace(/\0.*$/s, '');
    const stored = parseInt(field(148, 8).trim(), 8);
    const sum = [...header].reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    expect(sum).toBe(stored);
    expect(field(257, 6)).toBe('ustar');
    const size = parseInt(field(124, 12), 8);
    const data = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (field(156, 1) === 'x') {
      const record = data.toString('utf8');
      const length = Number(record.split(' ')[0]);
      expect(Buffer.byteLength(record)).toBe(length);
      paxName = /path=(.*)\n$/s.exec(record)![1];
      continue;
    }
    out.push({ name: paxName ?? header.toString('utf8', 0, 100).replace(/\0.*$/s, ''), mode: parseInt(field(100, 8), 8), data });
    paxName = undefined;
  }
  return out;
}

it('writes ustar entries with their bytes, modes and a fixed time, ending in two empty blocks', () => {
  const files = new Map([
    ['Dockerfile', Buffer.from('FROM scratch\n')],
    ['bin/run.sh', Buffer.from('#!/bin/sh\n')],
    ['empty', Buffer.alloc(0)],
    ['exact', Buffer.alloc(512, 7)],
  ]);
  const archive = tarFiles(files, new Set(['bin/run.sh']));
  expect(archive.length % 512).toBe(0);
  expect(archive.subarray(-1024).every((b) => b === 0)).toBe(true);
  expect(untar(archive)).toEqual([
    { name: 'Dockerfile', mode: 0o644, data: files.get('Dockerfile') },
    { name: 'bin/run.sh', mode: 0o755, data: files.get('bin/run.sh') },
    { name: 'empty', mode: 0o644, data: Buffer.alloc(0) },
    { name: 'exact', mode: 0o644, data: files.get('exact') },
  ]);
  expect(archive.toString('latin1', 136, 147)).toBe('00000000000');
  // The same files make the same archive: BuildKit's cache keys stay the same.
  expect(tarFiles(files, new Set(['bin/run.sh']))).toEqual(archive);
});

it('names long and non-ASCII paths in a pax header, whatever their length', () => {
  const names = ['資料/頁面.py', 'a/'.repeat(60) + 'deep.txt', 'x'.repeat(100), 'y'.repeat(101), 'z'.repeat(1000)];
  const files = new Map(names.map((name, i) => [name, Buffer.from(String(i))] as const));
  expect(untar(tarFiles(files)).map((f) => [f.name, f.data.toString()])).toEqual(names.map((name, i) => [name, String(i)]));
});
