import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send } from '../support/app';

test.skip(process.env.E2E_PREVIEW_DOCKER !== '1', 'Requires a local Docker engine running Linux containers.');

test('a built frontend and a SQLite backend run through the signed-in preview panel', async ({ page, relay }) => {
  test.setTimeout(240_000);
  function project(name: string, scripts: Record<string, string>) {
    const folder = join(relay.workDir, name);
    mkdirSync(folder);
    const save = (file: string, content: string) => writeFileSync(join(folder, file), content);
    const pkg = { name, version: '1.0.0' };
    save('package.json', JSON.stringify({ ...pkg, scripts }));
    save('package-lock.json', JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }));
    return save;
  }
  const frontend = project('frontend', { build: 'node build.cjs' });
  frontend(
    'build.cjs',
    "const fs=require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/index.html','<h1>Built inside Docker</h1>')",
  );
  const backend = project('backend', { build: 'node build.cjs', start: 'node server.cjs' });
  backend('page.html', '<!doctype html><button>Save entry</button><output></output><script src="/client.js"></script>');
  backend(
    'client.js',
    `async function load() {
    const entries=await (await fetch('/api/entries')).json();
    document.querySelector('output').textContent=entries.length+' entries';
  }
  document.querySelector('button').onclick=async()=>{ await fetch('/api/entries',{method:'POST'}); await load() }; load();`,
  );
  backend(
    'server.cjs',
    `const {createServer}=require('node:http');
  const {DatabaseSync}=require('node:sqlite'); const {readFileSync}=require('node:fs');
  const db=new DatabaseSync('entries.sqlite'); db.exec('create table entries (id integer)');
  createServer((req,res)=>{
    if(req.url==='/') {
      res.writeHead(302,{Location:new URL('/entries', 'http://'+req.headers.host).href}); res.end(); return;
    }
    if(req.url==='/api/entries') {
      if(req.method==='POST') db.exec('insert into entries values (1)');
      res.setHeader('content-type','application/json'); res.end(JSON.stringify(db.prepare('select * from entries').all())); return;
    }
    const js=req.url==='/client.js';
    res.setHeader('content-type',js?'text/javascript':'text/html'); res.end(readFileSync(js?'client.js':'page.html'));
  }).listen(Number(process.env.PORT),process.env.HOST);`,
  );
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await send(page, 'Try these projects.\n[Frontend](frontend/package.json)\n[Backend](backend/package.json)');
  const reply = await finishedReply(page, 'Claude');
  const previews = reply.getByRole('button', { name: 'Preview app' });
  await expect(previews).toHaveCount(2);
  await previews.nth(0).click();
  const panel = page.getByLabel('App preview', { exact: true });
  const frame = panel.frameLocator('iframe');
  await expect(frame.getByRole('heading')).toHaveText('Built inside Docker', { timeout: 150_000 });
  await panel.getByRole('button', { name: 'Stop preview' }).click();
  await panel.getByRole('button', { name: 'Close' }).click();
  await previews.nth(1).click();
  await expect(frame.locator('output')).toHaveText('0 entries', { timeout: 90_000 });
  await frame.getByRole('button', { name: 'Save entry' }).click();
  await expect(frame.locator('output')).toHaveText('1 entries');
  const read = page.waitForResponse((r) => r.url().endsWith('/api/entries') && r.request().method() === 'GET' && r.status() === 200);
  await panel.getByRole('button', { name: 'Reload page' }).click();
  expect(await (await read).json()).toHaveLength(1);
  await expect(frame.locator('output')).toHaveText('1 entries');
  await panel.getByRole('button', { name: 'Rebuild preview' }).click();
  await expect(frame.locator('output')).toHaveText('0 entries', { timeout: 90_000 });
  await panel.getByRole('button', { name: 'Stop preview' }).click();
  await expect(panel.locator('iframe')).toHaveCount(0);
});
