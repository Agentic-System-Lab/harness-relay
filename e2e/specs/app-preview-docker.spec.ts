import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send } from '../support/app';

test.skip(process.env.E2E_PREVIEW_DOCKER !== '1', 'Requires a local Docker engine running Linux containers.');

test('a built frontend and a SQLite backend run through the signed-in preview panel', async ({ page, relay }) => {
  test.setTimeout(240_000);
  const save = (name: string, content: string) => writeFileSync(join(relay.workDir, name), content);
  save(
    'package.json',
    JSON.stringify({ name: 'preview-acceptance', version: '1.0.0', scripts: { build: 'node build.cjs', start: 'node server.cjs' } }),
  );
  save(
    'package-lock.json',
    JSON.stringify({
      name: 'preview-acceptance',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'preview-acceptance', version: '1.0.0' } },
    }),
  );
  save(
    'build.cjs',
    "const fs=require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/index.html','<h1>Built inside Docker</h1>')",
  );
  save('page.html', '<!doctype html><button>Save entry</button><output></output><script src="/client.js"></script>');
  save(
    'client.js',
    `async function load() {
    const entries=await (await fetch('/api/entries')).json();
    document.querySelector('output').textContent=entries.length+' entries';
  }
  document.querySelector('button').onclick=async()=>{ await fetch('/api/entries',{method:'POST'}); await load() }; load();`,
  );
  save(
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
  await send(page, 'Here is the preview.\n[Project](package.json)');
  const reply = await finishedReply(page, 'Claude');
  await reply.getByRole('button', { name: 'Preview app' }).click();
  const panel = page.getByLabel('App preview', { exact: true });
  const frame = panel.frameLocator('iframe');
  await panel.getByRole('button', { name: 'Start preview' }).click();
  await expect(frame.getByRole('heading')).toHaveText('Built inside Docker', { timeout: 150_000 });
  await panel.getByRole('button', { name: 'Stop preview' }).click();
  await panel.getByLabel('Preview mode').selectOption('server');
  await panel.getByRole('button', { name: 'Start preview' }).click();
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
