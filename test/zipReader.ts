import { crc32, inflateRawSync } from 'node:zlib';

/** One entry of a ZIP file, as `readZip` found it. */
export interface ReadEntry {
  name: string;
  data: Buffer;
  /** General purpose flags (bit 3: data descriptor, bit 11: UTF-8 name). */
  flags: number;
  method: number;
  /** MS-DOS time and date. */
  time: number;
  date: number;
  /** External attributes (Unix mode in the high half). */
  attributes: number;
}

/**
 * Reads a ZIP file the way an unzip tool does — from its central directory — and checks every local
 * header and data descriptor against it, and every file's CRC and size. Throws on anything wrong.
 */
export function readZip(buf: Buffer): ReadEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 !== buf.length) throw new Error('no end of central directory at the end');
  const count = buf.readUInt16LE(eocd + 10);
  if (buf.readUInt16LE(eocd + 8) !== count) throw new Error('entry counts differ');
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (p + cdSize !== eocd) throw new Error('central directory is not where it says');
  const out: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header ${i}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const attributes = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extra;

    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header ${i}`);
    if (buf.readUInt16LE(offset + 6) !== flags || buf.readUInt16LE(offset + 8) !== method) throw new Error(`headers differ ${i}`);
    const localName = buf.subarray(offset + 30, offset + 30 + buf.readUInt16LE(offset + 26));
    if (!localName.equals(nameBytes)) throw new Error(`names differ ${i}`);
    const start = offset + 30 + localName.length + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`unknown method ${method}`);
    if (data.length !== size) throw new Error(`size of ${nameBytes.toString()} is ${data.length}, not ${size}`);
    if (crc32(data) !== crc) throw new Error(`CRC of ${nameBytes.toString()} is wrong`);
    if (flags & 0x8) {
      const d = start + compressed;
      if (buf.readUInt32LE(d) !== 0x08074b50) throw new Error(`no data descriptor ${i}`);
      if (buf.readUInt32LE(d + 4) !== crc || buf.readUInt32LE(d + 8) !== compressed || buf.readUInt32LE(d + 12) !== size) {
        throw new Error(`data descriptor differs ${i}`);
      }
    }
    out.push({ name: nameBytes.toString('utf8'), data, flags, method, time, date, attributes });
  }
  return out;
}

/** Everything a ZIP stream yields, as one buffer. */
export async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of chunks) parts.push(c);
  return Buffer.concat(parts);
}
