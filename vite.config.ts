import { defineConfig, type Plugin, type Rolldown } from 'vite';
import react from '@vitejs/plugin-react';
import { DEV_WEB_PORT, apiPort } from './src/server/ports.ts';

/** The most a chunk loaded at startup may weigh (minified, in kB): the page waits for all of them. */
const STARTUP_CHUNK_LIMIT_KB = 500;

/**
 * Warn when a chunk the page loads at startup (an entry or anything it imports statically) grows past
 * the limit. Vite's own warning covers every chunk, and Mermaid's lazy ones (its elk layout engine,
 * its grammar parser) are larger than that and cannot be split; they load only when a diagram needs them.
 */
function startupChunkLimit(limitKb: number): Plugin {
  return {
    name: 'relay:startup-chunk-limit',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunk = (name: string) => bundle[name] as Rolldown.OutputChunk;
      const startup = new Set<string>();
      const visit = (name: string) => {
        if (startup.has(name)) return;
        startup.add(name);
        chunk(name).imports.forEach(visit);
      };
      for (const file of Object.values(bundle)) if (file.type === 'chunk' && file.isEntry) visit(file.fileName);
      for (const name of startup) {
        const kb = Buffer.byteLength(chunk(name).code) / 1000;
        if (kb > limitKb) this.warn(`${name} is loaded at startup and weighs ${kb.toFixed(0)} kB (limit ${limitKb} kB)`);
      }
    },
  };
}

/**
 * Fetch the words of the language the page will show together with the page's own files: the page
 * loads them before it is drawn (`loadMessages` in src/web/i18n.tsx), one round trip after its files
 * otherwise. The language saved in this browser (`STORAGE_KEY` there, saved from the first visit on);
 * none on a first visit, which waits for that round trip.
 */
function languagePreload(): Plugin {
  let base = '/';
  return {
    name: 'relay:language-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files: Record<string, string> = {};
        for (const file of Object.values(ctx.bundle ?? {})) {
          const lang = file.type === 'chunk' ? /[\\/]locales[\\/](zh-TW|en)\.ts$/.exec(file.facadeModuleId ?? '')?.[1] : undefined;
          if (lang) files[lang] = `${base}${file.fileName}`;
        }
        if (Object.keys(files).length !== 2) throw new Error(`languagePreload: expected the two languages' chunks, found ${JSON.stringify(files)}`);
        const script = [
          '(function () {',
          '  try {',
          `    var files = ${JSON.stringify(files)}, lang = localStorage.getItem('relay:lang');`,
          '    if (!lang || !Object.prototype.hasOwnProperty.call(files, lang)) return;',
          "    var link = document.createElement('link');",
          "    link.rel = 'modulepreload';",
          "    link.crossOrigin = '';",
          '    link.href = files[lang];',
          '    document.head.appendChild(link);',
          '  } catch (e) {}',
          '})();',
        ].join('\n');
        return [{ tag: 'script', children: script, injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig({
  root: 'src/web',
  plugins: [react(), startupChunkLimit(STARTUP_CHUNK_LIMIT_KB), languagePreload()],
  server: {
    port: DEV_WEB_PORT,
    // Trailing slash matters: a bare '/api' prefix would also swallow the client module '/api.ts'.
    proxy: { '/api/': { target: `http://localhost:${apiPort()}`, changeOrigin: false } },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // Startup chunks are checked by startupChunkLimit; this only has to fit Mermaid's lazy chunks.
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Libraries the page loads at startup, each in its own chunk: they change less often than
          // the app, so a browser keeps them across app updates. `$initial` leaves lazy code (Mermaid
          // and its dependencies) out of these chunks.
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, tags: ['$initial'], priority: 3 },
            { name: 'highlight', test: /node_modules[\\/](lowlight|highlight\.js)[\\/]/, tags: ['$initial'], priority: 2 },
            { name: 'vendor', test: /node_modules[\\/]/, tags: ['$initial'], priority: 1 },
          ],
        },
      },
    },
  },
});
