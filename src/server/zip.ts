import { createReadStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';

/*
 * A ZIP archive written as it goes, without holding a file in memory: each file is deflated while it
 * is read, and its CRC and sizes follow its data (a data descriptor). Names are UTF-8. No ZIP64: the
 * caller keeps an archive under 4 GB and 65,535 entries (FILE_LIMITS).
 */

export interface ZipEntry {
  /** The path inside the archive, with `/`; a folder's ends with `/` (made safe by `safeName`). */
  name: string;
  /** Last modified, in ms. */
  mtime: number;
  /** The file to read (none for a folder), or a stream of its bytes (tests). */
  source?: string | (() => Readable);
  /** Unix permission bits (e.g. 0o755 for a script); 0o644 for a file and 0o755 for a folder when absent. */
  mode?: number;
}

/** Flags: bit 3, sizes and CRC in a data descriptor after the data; bit 11, the name is UTF-8. */
const DESCRIPTOR = 0x0008;
const UTF8 = 0x0800;
const DEFLATE = 8;
const STORE = 0;
/** Made by Unix (3), spec version 2.0: the external attributes carry Unix modes. */
const MADE_BY = (3 << 8) | 20;
const NEEDED = 20;
const LIMIT = 0xffffffff;

/**
 * A name every unzip tool extracts inside its folder: `/` is the only separator, so a `\` in a file's
 * name (allowed on macOS and Linux) cannot climb out on Windows, and neither can `..`, a drive's `:`,
 * a leading `/` or a control character. Those characters become `_`.
 */
export function safeName(name: string): string {
  return name
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => {
      const safe = part.replace(/[\\:\x00-\x1f\x7f]/g, '_');
      return safe === '.' || safe === '..' ? '_' : safe;
    })
    .join('/');
}

/** A moment as an MS-DOS time and date (local time, 2-second steps, from 1980). */
export function dosDateTime(ms: number): { time: number; date: number } {
  let d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1980) d = new Date(1980, 0, 1);
  const year = Math.min(d.getFullYear(), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Written {
  name: Buffer;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  folder: boolean;
  mode: number;
}

function localHeader(w: Written): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(NEEDED, 4);
  b.writeUInt16LE(w.flags, 6);
  b.writeUInt16LE(w.method, 8);
  b.writeUInt16LE(w.time, 10);
  b.writeUInt16LE(w.date, 12);
  // CRC and sizes: 0 here for a file (they follow its data); a folder has none.
  b.writeUInt16LE(w.name.length, 26);
  return Buffer.concat([b, w.name]);
}

function descriptor(w: Written): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(w.crc, 4);
  b.writeUInt32LE(w.compressed, 8);
  b.writeUInt32LE(w.size, 12);
  return b;
}

function centralHeader(w: Written): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(MADE_BY, 4);
  b.writeUInt16LE(NEEDED, 6);
  b.writeUInt16LE(w.flags, 8);
  b.writeUInt16LE(w.method, 10);
  b.writeUInt16LE(w.time, 12);
  b.writeUInt16LE(w.date, 14);
  b.writeUInt32LE(w.crc, 16);
  b.writeUInt32LE(w.compressed, 20);
  b.writeUInt32LE(w.size, 24);
  b.writeUInt16LE(w.name.length, 28);
  // The Unix type and permissions in the high half, and the MS-DOS folder bit.
  b.writeUInt32LE(w.folder ? (((0o40000 | w.mode) << 16) | 0x10) >>> 0 : ((0o100000 | w.mode) << 16) >>> 0, 38);
  b.writeUInt32LE(w.offset, 42);
  return Buffer.concat([b, w.name]);
}

function end(count: number, size: number, offset: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  return b;
}

/**
 * The archive of `entries`, in order, as chunks to send. A file that cannot be opened is left out; one
 * that fails while it is read ends the archive with that error. Stopping early (the download was
 * cancelled), wherever it stops, closes the file that is open.
 */
export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const written: Written[] = [];
  let offset = 0;
  const check = (n: number) => {
    if (n > LIMIT) throw new Error('The archive is too large for a ZIP file without ZIP64');
    return n;
  };
  for (const e of entries) {
    const folder = !e.source;
    let source: Readable | undefined;
    if (!folder) {
      try {
        source = typeof e.source === 'string' ? await opened(e.source) : e.source!();
      } catch {
        continue; // gone since it was listed
      }
    }
    // From here on the file is open: closed however this entry ends, a cancel at any yield included.
    try {
      const { time, date } = dosDateTime(e.mtime);
      const name = safeName(e.name);
      const w: Written = {
        name: Buffer.from(folder && !name.endsWith('/') ? `${name}/` : name, 'utf8'),
        flags: folder ? UTF8 : UTF8 | DESCRIPTOR,
        method: folder ? STORE : DEFLATE,
        time,
        date,
        crc: 0,
        compressed: 0,
        size: 0,
        offset,
        folder,
        mode: (e.mode ?? (folder ? 0o755 : 0o644)) & 0o777,
      };
      const header = localHeader(w);
      offset = check(offset + header.length);
      yield header;
      if (source) {
        const deflate = createDeflateRaw();
        const measure = new Transform({
          transform(chunk: Buffer, _enc, done) {
            w.crc = crc32(chunk, w.crc);
            w.size += chunk.length;
            done(null, chunk);
          },
        });
        const piping = pipeline(source, measure, deflate);
        // Read the output while it is piped; a failure on either side ends the archive.
        piping.catch(() => {});
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          w.compressed += chunk.length;
          offset = check(offset + chunk.length);
          yield chunk;
        }
        await piping;
        check(w.size);
        const tail = descriptor(w);
        offset = check(offset + tail.length);
        yield tail;
      }
      written.push(w);
    } finally {
      source?.destroy();
    }
  }
  if (written.length > 0xffff) throw new Error('Too many entries for a ZIP file without ZIP64');
  const start = offset;
  let size = 0;
  for (const w of written) {
    const h = centralHeader(w);
    size += h.length;
    yield h;
  }
  check(start + size);
  yield end(written.length, size, start);
}

/** A file's read stream once it is open (so a file that cannot be opened is known before its header). */
function opened(path: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const s = createReadStream(path);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
}
