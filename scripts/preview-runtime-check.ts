/** Opt-in live Docker checks: npx tsx scripts/preview-runtime-check.ts. Linux containers and the public npm registry are required. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runProcess } from '../src/server/process';
import { cleanupPreviewRuntimes, startPreviewRuntime } from '../src/server/previewRuntime';

const owner = 'check-' + randomUUID();
const signal = AbortSignal.timeout(240_000);

async function fixture(pkg: object, source: Record<string, string>): Promise<Map<string, Buffer>> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-preview-check-'));
  try {
    const manifest = JSON.stringify(pkg);
    await writeFile(join(dir, 'package.json'), manifest);
    // A workspace's lockfile records its members, so npm needs their manifests beside the root's.
    for (const [name, text] of Object.entries(source)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), text);
    }
    // Only this script's fixed test manifests ever go to this setup command. It creates a public
    // lockfile for the architecture matrix without installing or executing third-party code.
    const result = await runProcess({
      bin: 'npm',
      args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'],
      cwd: dir,
      env: process.env,
      signal,
      timeoutMs: 60000,
    });
    assert.equal(result.code, 0, result.stderr);
    return new Map(Object.entries({ 'package.json': manifest, ...source }).map(([name, txt]) => [name, Buffer.from(txt)] as const)).set(
      'package-lock.json',
      await readFile(join(dir, 'package-lock.json')),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const backend = `
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync('todo.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT)');
const app = new Hono();
app.get('/',ctx=>ctx.html('<h1>Todos</h1>'));
app.get('/isolation',ctx=>ctx.json({uid:process.getuid(),cookie:ctx.req.header('Cookie')??'',auth:ctx.req.header('Authorization')??'',net:readFileSync('/proc/net/dev','utf8').split('\\n').slice(2).map(s=>s.split(':')[0].trim()).filter(Boolean)}));
app.get('/todos',ctx=>ctx.json(db.prepare('SELECT * FROM todos ORDER BY id').all()));
app.post('/todos',async ctx=>{db.prepare('INSERT INTO todos(title) VALUES (?)').run((await ctx.req.json()).title); return ctx.body(null,201)});
app.patch('/todos/:id',async ctx=>{db.prepare('UPDATE todos SET title=? WHERE id=?').run((await ctx.req.json()).title,ctx.req.param('id'));return ctx.body(null,204)});
app.delete('/todos/:id',ctx=>{db.prepare('DELETE FROM todos WHERE id=?').run(ctx.req.param('id'));return ctx.body(null,204)});
serve({fetch:app.fetch,hostname:process.env.HOST,port:Number(process.env.PORT)});
`;

try {
  const files = await fixture(
    {
      name: 'preview-check-frontend',
      private: true,
      scripts: { build: './scripts/build.sh' },
      dependencies: { react: '19.3.1', 'react-dom': '19.3.1' },
      devDependencies: { vite: '7.2.2' },
    },
    {
      'scripts/build.sh':
        '#!/bin/sh\nset -eu\ntest "$(stat -c %a scripts/build.sh)" = 700\ntest "$(stat -c %a main.jsx)" = 600\nexec vite build\n',
      'index.html': '<html><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>',
      'main.jsx':
        "import React from 'react';import{createRoot}from'react-dom/client';function Counter(){const[count,set]=React.useState(0);return <button onClick={()=>set(count+1)}>Count {count}</button>}createRoot(document.querySelector('#root')).render(<Counter/>);",
    },
  );
  const site = await startPreviewRuntime({ files, mode: 'build', signal, owner, executables: new Set(['scripts/build.sh']) });
  try {
    const index = await (await site.request(new Request('http://preview/'))).text();
    const src = /src="(\/assets\/[^"]+\.js)"/.exec(index)?.[1];
    assert.ok(src, 'Vite must produce a hashed JS bundle.');
    const js = await site.request(new Request('http://preview' + src));
    assert.equal(js.status, 200);
    assert.ok((await js.text()).includes('Count'));
    assert.equal((await site.request(new Request('http://preview/main.jsx'))).status, 404);
  } finally {
    await site.stop();
  }
  console.log('React/Vite production build and public assets passed.');

  const apiFiles = await fixture(
    {
      name: 'preview-check-todos',
      private: true,
      type: 'module',
      scripts: { start: 'node server.js' },
      dependencies: { hono: '4.13.17', '@hono/node-server': '2.1.6' },
    },
    { 'server.js': backend },
  );
  const api = await startPreviewRuntime({ files: apiFiles, mode: 'server', signal, owner });
  const req = (path: string, method = 'GET', body?: object) =>
    api.request(
      new Request('http://preview' + path, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: 'private-cookie', Authorization: 'secret' },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  try {
    assert.deepEqual(await (await req('/isolation')).json(), { uid: 1000, cookie: '', auth: '', net: ['lo'] });
    assert.match(await (await req('/')).text(), /Todos/);
    assert.equal((await req('/todos', 'POST', { title: 'preview' })).status, 201);
    assert.deepEqual(await (await req('/todos')).json(), [{ id: 1, title: 'preview' }]);
    assert.equal((await req('/todos/1', 'PATCH', { title: 'updated' })).status, 204);
    assert.deepEqual(await (await req('/todos')).json(), [{ id: 1, title: 'updated' }]);
    assert.equal((await req('/todos/1', 'DELETE')).status, 204);
    assert.deepEqual(await (await req('/todos')).json(), []);
    assert.equal((await req('/todos', 'POST', { title: 'temporary' })).status, 201);
  } finally {
    await api.stop();
  }
  const second = await startPreviewRuntime({ files: apiFiles, mode: 'server', signal, owner });
  try {
    assert.deepEqual(await (await second.request(new Request('http://preview/todos'))).json(), []);
  } finally {
    await second.stop();
  }
  console.log('SQLite CRUD, loopback-only network, filtered headers and disposable data passed.');

  // An npm workspace: the lockfile at the root, the selected member found by a glob, its default
  // `node server.js`, the root's own dependencies installed, a sibling member's left out.
  const workspaceFiles = await fixture(
    { name: 'preview-check-workspace', private: true, workspaces: ['apps/*'], devDependencies: { ms: '2.1.3' } },
    {
      'apps/api/package.json': JSON.stringify({
        name: 'preview-check-api',
        private: true,
        type: 'module',
        dependencies: { hono: '4.13.17', '@hono/node-server': '2.1.6' },
      }),
      'apps/api/server.js': `
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import ms from 'ms';
const app = new Hono();
app.get('/',ctx=>ctx.json({cwd:process.cwd(),root:ms('1m'),sibling:existsSync('/work/app/node_modules/is-number')}));
serve({fetch:app.fetch,hostname:process.env.HOST,port:Number(process.env.PORT)});
`,
      'apps/other/package.json': JSON.stringify({ name: 'preview-check-other', private: true, dependencies: { 'is-number': '7.0.0' } }),
    },
  );
  const member = await startPreviewRuntime({ files: workspaceFiles, mode: 'server', workspace: 'apps/api', signal, owner });
  try {
    assert.deepEqual(await (await member.request(new Request('http://preview/'))).json(), {
      cwd: '/work/app/apps/api',
      root: 60000,
      sibling: false,
    });
  } finally {
    await member.stop();
  }
  console.log('npm workspace member with the root lockfile passed.');
} finally {
  await cleanupPreviewRuntimes(owner);
}
