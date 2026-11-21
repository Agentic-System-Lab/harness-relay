'use strict';

// A process-scoped Microsoft Graph session for the Teams browser tests. It implements only
// the fixed PowerShell commands Relay runs and the JSON lines exchanged with that session.
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve, sep } = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const folder = join(process.env.USERPROFILE || process.env.HOME, 'e2e-teams');
const marker = (name) => join(folder, name);
const tenant = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const sender = '33333333-3333-4333-8333-333333333333';
const channel = '19:planning@thread.tacv2';
const reply = (event) => process.stdout.write('RELAY ' + JSON.stringify(event) + '\n');
async function waitFor(name) {
  while (!existsSync(marker(name))) await delay(40);
}
async function run() {
  const script = process.argv.at(-1);
  if (script === '--version' || script === '-Version' || script === '-v') return console.log('PowerShell 7.6.10');
  if (!script?.includes('Microsoft.Graph.Authentication')) return 20;
  mkdirSync(folder, { recursive: true });
  // The download scenario starts without a usable system runtime. Only its staged and
  // subsequently published private pwsh (inside this test's data folder) may run.
  const exe = require('node:sea').isSea() ? process.execPath : process.argv[1];
  const data = resolve(dirname(process.env.USERPROFILE), 'data') + sep;
  if (existsSync(marker('require-private-runtime')) && !resolve(exe).startsWith(data)) return 20;
  const privateModules = join(data, 'clis', 'teams-modules');
  if (process.env.RELAY_TEAMS_MODULES !== privateModules || !script.includes('PSModulePath = @($env:RELAY_TEAMS_MODULES,')) return 22;
  const moduleName = 'Microsoft.Graph.Authentication';
  const privateMarker = join(privateModules, moduleName, 'module.fixture');
  const systemMarker = marker('graph-module');
  if (script.includes('Save-PSResource')) {
    if (!script.includes('Import-Module -Name ($manifest[0].FullName) -ErrorAction Stop')) return 22;
    const stage = process.env.RELAY_TEAMS_MODULE_STAGE;
    if (!stage || !stage.startsWith(privateModules + '-install-') || !script.includes('-Path $env:RELAY_TEAMS_MODULE_STAGE')) return 22;
    const gallery = /^\s*\$gallery = '([^']+)'\s*$/m.exec(script)?.[1];
    if (gallery !== 'https://www.powershellgallery.com/api/v2' || !script.includes('-Repository PSGallery')) return 22;
    await waitFor('allow-module-install');
    if (existsSync(marker('bad-staged-module'))) return 22;
    mkdirSync(join(stage, moduleName), { recursive: true });
    writeFileSync(join(stage, moduleName, 'module.fixture'), 'Microsoft.Graph.Authentication');
    return 0;
  }
  const existing = existsSync(privateMarker) ? privateMarker : systemMarker;
  if (!existsSync(existing)) return 21;
  if (readFileSync(existing, 'utf8') === 'broken' && script.includes('Import-Module -Name $name -ErrorAction Stop')) return 21;
  if (!script.includes('Connect-MgGraph')) return 0;
  if (!script.includes('-UseDeviceCode -ContextScope Process')) return 23;
  const posting = script.includes("'ChannelMessage.Send'");
  process.stdout.write('Open https://microsoft.com/devicelogin and enter ' + (posting ? 'POST12345' : 'TEAMS1234') + '\n');
  await waitFor(posting ? 'approve-post' : 'approve-read');
  reply({ account: 'ming@example.test', tenantId: tenant });
  for await (const line of createInterface({ input: process.stdin })) {
    const req = JSON.parse(line);
    const url = new URL(req.uri);
    if (url.origin !== 'https://graph.microsoft.com') return 23;
    const path = decodeURIComponent(url.pathname);
    let data;
    if (posting && path === '/v1.0/me') data = { id: sender };
    else if (!posting && path === '/v1.0/me/joinedTeams') data = { value: [{ id: team, displayName: 'Product team' }] };
    else if (posting && path === '/v1.0/teams/' + team) data = { id: team, displayName: 'Product team', tenantId: tenant };
    else if (posting && path === '/v1.0/teams/' + team + '/channels/' + channel)
      data = { id: channel, displayName: 'Planning', tenantId: tenant };
    else if (posting && path === '/v1.0/teams/' + team + '/channels/' + channel + '/messages' && typeof req.text === 'string') {
      appendFileSync(marker('posts.jsonl'), JSON.stringify({ path, text: req.text }) + '\n');
      data = { id: '42' };
    } else {
      reply({ id: req.id, error: 'graph', status: 403 });
      continue;
    }
    reply({ id: req.id, json: JSON.stringify(data) });
  }
  return 0;
}
run().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    console.error(err.message);
    process.exitCode = 1;
  },
);
