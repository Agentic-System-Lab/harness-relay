// Serves the landing page (site/) locally the way GitHub Pages will: the demo videos are read
// from docs/media/ under /media/, and Markdown files and image provenance sidecars are not served.
// Usage: npm run site:preview   (SITE_PORT changes the port, default 4180)

import { createReadStream, statSync, type Stats } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const siteDir = join(repo, 'site');
const mediaDir = join(repo, 'docs', 'media');
const port = Number(process.env.SITE_PORT ?? 4180);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

/** Files that stay in the repository only, like the Pages workflow leaves them out. */
const hidden = (file: string) => file.endsWith('.md') || file.endsWith('.webp.json') || file.endsWith('.d.ts');

function inside(base: string, rel: string): string | null {
  const file = resolve(base, rel);
  return file === base || file.startsWith(base + sep) ? file : null;
}

function stat(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const server = createServer((req, res) => {
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return notFound(res);
  }

  let file = path.startsWith('/media/') ? inside(mediaDir, path.slice('/media/'.length)) : inside(siteDir, path.slice(1));
  let info = file ? stat(file) : null;

  if (file && info?.isDirectory()) {
    // Relative links in a page need the trailing slash (zh-TW → zh-TW/).
    if (!path.endsWith('/')) {
      res.writeHead(301, { Location: `${path}/` });
      return res.end();
    }
    file = join(file, 'index.html');
    info = stat(file);
  }
  if (!file || !info?.isFile() || hidden(file)) return notFound(res);

  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  // Byte ranges let the browser seek in the demo video, as it can on GitHub Pages.
  if (range && (range[1] || range[2])) {
    const size = info.size;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Landing page preview: http://127.0.0.1:${port}/  (繁體中文: http://127.0.0.1:${port}/zh-TW/)`);
});
