import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const prefix = '/help/oauth/';
const style = `
  :root { color-scheme: light dark; font: 1rem/1.65 system-ui, sans-serif }
  body { max-width: 56rem; margin: 0 auto; padding: 1.25rem clamp(1rem, 5vw, 3rem) 3rem; overflow-wrap: anywhere }
  h1 { line-height: 1.2 }
  ol, ul { padding-inline-start: 1.6rem }
  li + li { margin-top: .65rem }
  figure { margin: 2rem 0 }
  figure img { display: block; max-width: 100%; height: auto; cursor: zoom-in }
  figcaption { margin-top: .5rem; font-size: .9rem }
  a { color: LinkText; text-underline-offset: .15em }
`;

/** The same two articles and their linked images as the website, without its navigation or JavaScript. */
function guideFiles(root: string) {
  const files = new Map<string, { content: string | Buffer; mime: string }>();
  for (const lang of ['en', 'zh-TW']) {
    const source = resolve(root, 'site', lang === 'en' ? '' : lang, 'docs/tools/index.html');
    const html = readFileSync(source, 'utf8');
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    for (const provider of ['google', 'microsoft']) {
      const id = provider + '-oauth-setup';
      const section = html.match(new RegExp('<section id="' + id + '"[^>]*>([\\s\\S]*?)</section>'))?.[1];
      const heading = section?.match(/<h2[^>]*>(?:<svg\b[^>]*>[\s\S]*?<\/svg>)?\s*([^<]+)<\/h2>/)?.[1];
      if (!section || !heading || !canonical) throw new Error(`Missing OAuth guide, heading or canonical URL for ${id} in ${source}`);
      const article = section
        .replace(/<h2[^>]*>[\s\S]*?<\/h2>/, `<h1>${heading}</h1>`)
        .replace(/href="#/g, 'href="' + canonical + '#')
        .replace(/(?:\.\.\/)+assets\/media\/docs\/([\w.-]+\.(webp|png))/g, (_, image: string, extension: string) => {
          const path = 'images/' + image;
          if (!files.has(path))
            files.set(path, { content: readFileSync(resolve(root, 'site/assets/media/docs', image)), mime: 'image/' + extension });
          return '../' + path;
        });
      const content = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'">
  <title>${heading} · Harness Relay</title>
  <style>${style}</style>
</head>
<body><main>${article}</main></body>
</html>`;
      files.set(lang + '/' + provider + '.html', { content, mime: 'text/html; charset=utf-8' });
    }
  }
  return files;
}

export function oauthGuides(): Plugin {
  let root: string;
  return {
    name: 'relay:oauth-guides',
    configResolved(config) {
      root = resolve(config.root, '../..');
    },
    generateBundle() {
      for (const [name, file] of guideFiles(root)) {
        this.emitFile({ type: 'asset', fileName: prefix.slice(1) + name, source: file.content });
      }
    },
    configureServer(server) {
      // Read current source on each guide request so edits to the website also appear during development.
      server.middlewares.use(prefix, (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' }).end();
          return;
        }
        const name = (req.url ?? '').split('?')[0]!.slice(1);
        const file = guideFiles(root).get(name);
        if (!file) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : file.content);
      });
    },
  };
}
