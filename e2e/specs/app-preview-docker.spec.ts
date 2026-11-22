import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, send } from '../support/app';

test.skip(process.env.E2E_PREVIEW_DOCKER !== '1', 'Requires a local Docker engine running Linux containers.');
// The test server has a home of its own. Docker Desktop and OrbStack keep the Compose and buildx
// plugins in the user's Docker folder, which it then finds through DOCKER_CONFIG.
const dockerConfig = process.env.DOCKER_CONFIG ?? join(homedir(), '.docker');
if (existsSync(dockerConfig)) test.use({ serverEnv: { DOCKER_CONFIG: dockerConfig } });

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

/** A Python web server on PORT (or the port given), whose page shows `title` and what it checked. */
function pythonServer(title: string, checks = '') {
  return `import http.server, os, socket
def egress():
    try:
        socket.create_connection(("1.1.1.1", 80), timeout=2); return "online"
    except OSError:
        return "offline"
${checks}
class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = ("<h1>${title}</h1><output>" + egress() + extra() + "</output>").encode()
        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(body)
port = int(os.environ.get("PORT", "80"))
print("serving on", port, flush=True)
http.server.HTTPServer(("0.0.0.0", port), Page).serve_forever()
`;
}

test('a Dockerfile app in another language shows its build in the terminal, then its page', async ({ page, relay }) => {
  test.setTimeout(240_000);
  const web = join(relay.workDir, 'pyweb');
  mkdirSync(web);
  writeFileSync(join(web, 'Dockerfile'), 'FROM python:3.13-slim\nWORKDIR /app\nCOPY app.py .\nEXPOSE 8000\nCMD ["python","-u","app.py"]\n');
  writeFileSync(join(web, 'app.py'), pythonServer('Hello from Python', 'def extra():\n    return " port " + os.environ["PORT"]'));
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await send(page, 'Try it.\n[Python app](pyweb/Dockerfile)');
  await (await finishedReply(page, 'Claude')).getByRole('button', { name: 'Preview app' }).click();
  const panel = page.getByLabel('App preview', { exact: true });
  await expect(panel.getByRole('radio', { name: 'Terminal' })).toBeChecked();
  const frame = panel.frameLocator('iframe');
  await expect(frame.getByRole('heading')).toHaveText('Hello from Python', { timeout: 180_000 });
  // No network for the app, and the port its image EXPOSEs.
  await expect(frame.locator('output')).toHaveText('offline port 8000');
  await panel.getByRole('radio', { name: 'Terminal' }).click();
  await expect(panel.locator('.xterm-rows')).toContainText('serving on 8000');
  await panel.getByRole('radio', { name: 'Page' }).click();
  await expect(frame.getByRole('heading')).toBeVisible();
  await panel.getByRole('button', { name: 'Stop preview' }).click();
  await expect(panel.locator('iframe')).toHaveCount(0);
});

test('a terminal app takes typed input, runs again with another command, opens a shell and reports its exit', async ({ page, relay }) => {
  test.setTimeout(240_000);
  const tool = join(relay.workDir, 'greeter');
  mkdirSync(tool);
  writeFileSync(join(tool, 'Dockerfile'), 'FROM python:3.13-slim\nCOPY greet.py /greet.py\nCMD ["python", "/greet.py"]\n');
  writeFileSync(
    join(tool, 'greet.py'),
    'import sys\nname = input("Your name? ")\nprint("Hello,", name, " ".join(sys.argv[1:]))\nraise SystemExit(2 if name == "fail" else 0)\n',
  );
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
  const files = page.getByRole('dialog', { name: 'Files' });
  await files.getByRole('button', { name: 'greeter', exact: true }).click();
  await files.getByRole('button', { name: 'Preview this folder' }).click();
  const panel = page.getByLabel('App preview', { exact: true });
  const screen = panel.locator('.xterm-rows');
  await expect(screen).toContainText('Your name?', { timeout: 180_000 });
  await panel.locator('.xterm-screen').click();
  await page.keyboard.type('Relay');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('Hello, Relay');
  await expect(panel.getByRole('status')).toHaveText('The app exited (exit code 0).');
  const command = panel.getByRole('textbox', { name: 'Command' });
  await expect(command).toHaveValue('python /greet.py');
  await command.fill('python /greet.py --again');
  await panel.getByRole('button', { name: 'Run this command' }).click();
  await expect(screen).toContainText(/Your name\?[\s\S]*Your name\?/);
  await panel.locator('.xterm-screen').click();
  await page.keyboard.type('fail');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('Hello, fail --again');
  await expect(panel.getByRole('status')).toHaveText('The app exited (exit code 2).');
  await panel.getByRole('button', { name: 'Add errors to message' }).click();
  await expect(composer(page)).toHaveValue(/Hello, fail --again/);
  await panel.getByRole('button', { name: 'Open a shell' }).click();
  await expect(panel.getByRole('status')).toHaveText('Running. The page opens by itself once the app serves one.');
  await panel.locator('.xterm-screen').click();
  await page.keyboard.type('echo "port=$PORT user=$(id -u)"');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('port=4173 user=0');
  await panel.getByRole('button', { name: 'Stop preview' }).click();
});

test('a compose app reaches its own Redis service by name, with project files mounted and no way out', async ({ page, relay }) => {
  test.setTimeout(240_000);
  const app = join(relay.workDir, 'stack');
  mkdirSync(join(app, 'web'), { recursive: true });
  writeFileSync(
    join(app, 'compose.yaml'),
    `services:
  web:
    build: ./web
    ports: ["8080:80"]
    depends_on:
      cache: { condition: service_healthy }
    volumes: ["./web/greeting.txt:/srv/greeting.txt:ro"]
    environment: { MODE: "\${MODE:-preview}" }
  cache:
    image: redis:7-alpine
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 1s, retries: 30 }
`,
  );
  writeFileSync(join(app, 'web', 'Dockerfile'), 'FROM python:3.13-slim\nWORKDIR /srv\nCOPY app.py .\nCMD ["python", "-u", "app.py"]\n');
  writeFileSync(join(app, 'web', 'greeting.txt'), 'mounted');
  writeFileSync(
    join(app, 'web', 'app.py'),
    pythonServer(
      'Stack',
      `def extra():
    s = socket.create_connection(("cache", 6379), timeout=2); s.sendall(b"PING\\r\\n"); pong = s.recv(64).decode().strip(); s.close()
    return " " + pong + " " + open("/srv/greeting.txt").read() + " " + os.environ["MODE"]`,
    ),
  );
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await send(page, 'Try the stack.\n[Stack](stack/compose.yaml)');
  await (await finishedReply(page, 'Claude')).getByRole('button', { name: 'Preview app' }).click();
  const panel = page.getByLabel('App preview', { exact: true });
  const frame = panel.frameLocator('iframe');
  await expect(frame.locator('output')).toHaveText('offline +PONG mounted preview', { timeout: 180_000 });
  await panel.getByRole('button', { name: 'Stop preview' }).click();
  await expect(panel.locator('iframe')).toHaveCount(0);
});
