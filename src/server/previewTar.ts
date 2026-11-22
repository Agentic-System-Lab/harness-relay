/**
 * A tar archive of snapshot files, the build context `docker build -` reads from stdin. Nothing on
 * the host is named or mounted: the archive holds the bytes Relay already copied and checked.
 * POSIX ustar, with a pax header for a name longer than ustar holds or one that is not ASCII.
 */

const BLOCK = 512;

function octal(value: number, size: number): string {
  return value.toString(8).padStart(size - 1, '0') + '\0';
}

function header(name: string, size: number, mode: number, type: '0' | 'x'): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  // A fixed time keeps the context, and so BuildKit's cache, the same for the same files.
  block.write(octal(0, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** One pax record, `<length> path=<name>\n`, where the length counts its own digits. */
function paxPath(name: string): Buffer {
  const body = ` path=${name}\n`;
  const bytes = Buffer.byteLength(body);
  let length = bytes + 1;
  while (length !== bytes + String(length).length) length = bytes + String(length).length;
  return Buffer.from(length + body);
}

export function tarFiles(files: ReadonlyMap<string, Buffer>, executables: ReadonlySet<string> = new Set()): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of files) {
    const mode = executables.has(name) ? 0o755 : 0o644;
    if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) {
      const record = paxPath(name);
      parts.push(header('PaxHeader/' + String(parts.length), record.length, 0o644, 'x'), record, padding(record.length));
      parts.push(
        header(
          Buffer.from(name)
            .subarray(0, 100)
            .toString('latin1')
            .replace(/[^\x20-\x7e]/g, '_'),
          data.length,
          mode,
          '0',
        ),
      );
    } else {
      parts.push(header(name, data.length, mode, '0'));
    }
    parts.push(data, padding(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
