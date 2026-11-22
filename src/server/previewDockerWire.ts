import { t } from './i18n';
/** All project bytes cross Docker stdio. A file record has two uint32 lengths, its UTF-8 name and its raw bytes. The high bit of the name length grants owner execute on import. */
export const MAX_DIST = 32 * 1024 * 1024;
const MAX_FILES = 2048;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function fileName(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 4096 &&
    !/[\\\x00-\x1f]/.test(name) &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function encodePreviewFiles(files: ReadonlyMap<string, Buffer>, executable?: ReadonlySet<string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, bytes] of files) {
    if (!fileName(name)) throw new Error(t().previewDocker.invalidFile);
    const path = Buffer.from(name);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(path.length + (executable?.has(name) ? 0x80000000 : 0));
    header.writeUInt32BE(bytes.length, 4);
    chunks.push(header, path, bytes);
  }
  return Buffer.concat(chunks);
}

export function decodePreviewFiles(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > MAX_DIST) throw new Error(t().previewDocker.distSize);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length || files.size >= MAX_FILES) throw new Error(t().previewDocker.invalidOutput);
    const nameSize = bytes.readUInt32BE(offset) & 0x7fffffff;
    const size = bytes.readUInt32BE(offset + 4);
    offset += 8;
    if (nameSize > 4096 || size > MAX_FILE_BYTES || offset + nameSize + size > bytes.length)
      throw new Error(t().previewDocker.invalidOutput);
    const name = bytes.toString('utf8', offset, offset + nameSize);
    if (!fileName(name) || files.has(name)) throw new Error(t().previewDocker.invalidFile);
    offset += nameSize;
    files.set(name, bytes.subarray(offset, offset + size));
    offset += size;
  }
  return files;
}

// Fixed programs below run with the pinned Node inside the container, independent of the project,
// npm, its working directory and its installed packages.
const READ_STDIN = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
`;

export const IMPORT_FILES = `
import fs from 'node:fs';
import path from 'node:path';
${READ_STDIN}
let at = 0;
while (at < input.length) {
  const flags = input.readUInt32BE(at);
  const n = flags & 0x7fffffff, size = input.readUInt32BE(at + 4);
  at += 8;
  const dest = path.join('/work', input.toString('utf8', at, at+n));
  at += n;
  fs.mkdirSync(path.dirname(dest), {recursive:true});
  fs.writeFileSync(dest, input.subarray(at, at + size), {flag:'wx', mode: flags >= 0x80000000 ? 0o700 : 0o600});
  at += size;
}
`;

export const EXPORT_DIST = `
import fs from 'node:fs';
import path from 'node:path';
// The project's dist folder, an absolute path the runtime passes after the program.
const root = process.argv[1];
if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw Error('Build must produce a dist folder.');
let count = 0, size = 0;
function visit(dir, depth) {
  if (depth > 32) throw Error('Built folders are too deeply nested.');
  for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
    if (++count > ${MAX_FILES}) throw Error('Too many built files.');
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory() && fs.realpathSync(file) === file) visit(file,depth + 1);
    if (!item.isFile()) continue;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      // Check the opened file: even a background build process renaming an ancestor cannot
      // make this reader include an entry outside dist. Never block on pipes or devices.
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || fs.realpathSync('/proc/self/fd/' + fd) !== file) continue;
      const name = Buffer.from(path.relative(root,file));
      size += 8 + name.length + stat.size;
      if (stat.size > ${MAX_FILE_BYTES} || size > ${MAX_DIST}) throw Error('Built preview exceeds the output size limit.');
      const data = Buffer.alloc(stat.size);
      let read = 0;
      while (read < data.length) {
        const n = fs.readSync(fd, data, read, data.length-read, read);
        if (!n) throw Error('Built preview file changed while reading.');
        read += n;
      }
      const header = Buffer.alloc(8);
      header.writeUInt32BE(name.length);
      header.writeUInt32BE(data.length,4);
      fs.writeFileSync(1,header);
      fs.writeFileSync(1,name);
      fs.writeFileSync(1,data);
    } finally { fs.closeSync(fd); }
  }
}
visit(root,0);
`;

export const APP_PORT = 4173;

/**
 * Waits until something accepts connections on the port given after the program: exit 0. After the
 * seconds given second it gives up with exit 3, for Relay to ask again. Stopping \`docker exec\` stops
 * only the CLI, never what it started in the container: this also ends when its stdin does.
 */
export const WAIT_PORT = `
import net from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
const port = Number(process.argv[1]);
const deadline = Date.now() + 1000 * Number(process.argv[2] || 30);
// Relay holds stdin open while it waits: when it stops waiting, this ends with it.
process.stdin.on('end', () => process.exit(4));
process.stdin.on('error', () => process.exit(4));
process.stdin.resume();
for (;;) {
  const up = await new Promise(resolve => {
    const socket = net.connect(port,'127.0.0.1');
    socket.once('connect',()=>{socket.destroy();resolve(true)});
    socket.once('error',()=>{socket.destroy();resolve(false)});
  });
  if (up) break;
  if (Date.now() > deadline) process.exit(3);
  await sleep(300);
}
`;
export const REQUEST_LIMIT = 1024 * 1024;
export const RESPONSE_LIMIT = 8 * 1024 * 1024;
const RESPONSE_HEADERS = ['content-type', 'etag', 'location'] as const;
const REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'if-none-match'] as const;

export async function encodePreviewRequest(request: Request, signal = request.signal): Promise<Buffer> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const meta = Buffer.from(JSON.stringify({ method: request.method, path: url.pathname + url.search, headers }) + '\n');
  if (meta.length > 16384) throw new Error(t().previewDocker.headers);
  const chunks: Buffer[] = [meta];
  let size = 0;
  if (request.body) {
    signal.throwIfAborted();
    const reader = request.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.length;
        if (size > REQUEST_LIMIT) throw new Error(t().previewDocker.body);
        chunks.push(Buffer.from(value));
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel();
    }
  }
  return Buffer.concat(chunks);
}

export const FORWARD_HTTP = `
import http from 'node:http';
${READ_STDIN}
const line = input.indexOf(10);
const {method, path, headers} = JSON.parse(input.toString('utf8',0,line));
const body = input.subarray(line+1);
headers.host = 'preview.invalid';
if (body.length) headers['content-length'] = String(body.length);
const timeout = setTimeout(() => process.exit(1), 12000);
// The app's port inside the namespace: the one argument after the program, else PORT's default.
const req = http.request({hostname:'127.0.0.1', port:Number(process.argv[1]) || ${APP_PORT}, method, path, headers, maxHeaderSize:16384});
req.on('error', error => { console.error(error.message); process.exit(1); });
req.on('response', async res => {
  try {
    const headers = {};
    for (const name of ${JSON.stringify(RESPONSE_HEADERS)}) {
      if (typeof res.headers[name] === 'string') headers[name] = res.headers[name];
    }
    process.stdout.write(JSON.stringify({status:res.statusCode,headers}) + '\\n');
    let size = 0;
    for await (const chunk of res) {
      size += chunk.length;
      if (size > ${RESPONSE_LIMIT}) throw Error('Preview response exceeds 8 MiB.');
      if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once('drain',resolve));
    }
    clearTimeout(timeout);
  } catch (error) { console.error(error.message); process.exit(1); }
});
req.end(body);
`;

export function decodePreviewResponse(bytes: Buffer, method: string): Response {
  const split = bytes.indexOf(10);
  if (split <= 0 || split > 32768 || bytes.length - split - 1 > RESPONSE_LIMIT) throw new Error(t().previewDocker.invalidResponse);
  const { status, headers } = JSON.parse(bytes.toString('utf8', 0, split));
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error(t().previewDocker.invalidResponse);
  const allowed = new Headers();
  for (const name of RESPONSE_HEADERS) if (typeof headers?.[name] === 'string') allowed.set(name, headers[name]);
  const body = method === 'HEAD' || [204, 205, 304].includes(status) ? null : new Uint8Array(bytes.subarray(split + 1));
  return new Response(body, { status, headers: allowed });
}
