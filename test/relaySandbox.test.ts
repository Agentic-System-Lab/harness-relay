import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { approvalKeys } from '../src/server/approvals';
import type { ApprovalRequest } from '../src/server/agents/types';
import { withLang } from '../src/server/i18n';
import { CONTROL_CHANNEL, runProcess } from '../src/server/process';
import { RELAY_ROOT, agentFolders } from '../src/server/protect';
import {
  DENY_REASONS,
  canonicalHost,
  PROJECT_AGENT_CONFIG,
  projectAgentConfig,
  RELAY_SANDBOX_HOST,
  RelaySandboxRun,
  clearRelaySandboxLeftovers,
  leftoverSweepPids,
  failureText,
  hostArgs,
  hostNode,
  hostEnv,
  hostLabel,
  ipv6Groups,
  isLocalHost,
  isLoopbackHost,
  makeRunDirs,
  parseHostEntry,
  platformRefusal,
  relayPorts,
  relaySandboxConfig,
  relaySandboxEnv,
  SANDBOX_EXEC_PREFIX,
  SANDBOX_EXEC_SCRIPT,
  relaySandboxHosts,
  relaySandboxLocalPorts,
  relaySandboxConnectPorts,
  removeRunDirs,
  relaySandboxPaths,
  relaySandboxRefusal,
  relaySandboxRoot,
  freeLoopbackPort,
  relaySandboxHostRoot,
  HOST_TMP_MAX,
  sandboxAvailable,
  sandboxCommand,
  shellQuote,
  type RelaySandboxContext,
  type RelaySandboxSpec,
} from '../src/server/relaySandbox';
import type { ApprovalAnswer } from '../src/shared/types';

// In /tmp: the data folder's path must leave room for the sandbox's sockets (macOS's own temp folder is too deep).
const dir = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'relay-sbx-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const data = join(dir, 'data');
mkdirSync(join(data, 'tmp'), { recursive: true });
writeFileSync(join(data, 'relay.db'), '');
const home = join(dir, 'home');
mkdirSync(home, { recursive: true });
const cwd = join(home, 'project');
mkdirSync(cwd, { recursive: true });
const attachments = join(data, 'attachments', 'c1');
mkdirSync(attachments, { recursive: true });
const state = join(dir, 'agent-home', 'opencode', 'state');
const config = join(dir, 'agent-home', 'opencode', 'opencode.json');
const browser = join(home, 'Library', 'Application Support', 'Firefox');

const ctx: RelaySandboxContext = {
  platform: 'linux',
  arch: 'x64',
  home,
  dataDir: data,
  relayRoot: join(dir, 'relay'),
  relayPorts: [8787, 5173],
  localAddresses: ['127.0.0.1', '::1', '192.168.1.20', 'fe80::1'],
  tools: { sh: '/bin/sh', bash: '/bin/bash', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: '/usr/bin/rg' },
};

function spec(over: Partial<RelaySandboxSpec> = {}): RelaySandboxSpec {
  return {
    permission: 'read-only',
    cwd,
    writable: [state],
    readOnly: [config],
    protectedPaths: [browser],
    allowedHosts: ['api.openai.com'],
    attachmentsDir: attachments,
    ...over,
  };
}

const runDirs = { tmp: join(data, 'relay-sandbox', 'run1'), hostTmp: join(data, 'relay-sandbox', 'run1.host') };

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('relaySandboxPaths', () => {
  it("keeps every agent's project config and hook folders read-only in edit mode, Cline's .clinerules, Antigravity's other spellings of .agents and Copilot's in .github too", () => {
    for (const name of ['.clinerules', '.cline', 'opencode.json', 'opencode.jsonc', '.opencode', '.openhands', '.pi', '.agents', '.agent', '_agents', '_agent', '.goose', '.claude', '.codex', '.grok', '.cursor', '.mcp.json', '.github/hooks', '.github/copilot', '.github/mcp.json', '.github/lsp.json', '.github/extensions', '.github/agents']) {
      expect(PROJECT_AGENT_CONFIG).toContain(name);
    }
    const p = relaySandboxPaths(spec({ permission: 'edit' }), ctx, runDirs);
    expect(p.denyWrite).toContain(join(cwd, '.clinerules'));
  });

  it("writes the conversation's other working directories as the first, in edit mode only, each one's agent config read-only", () => {
    const docs = join(home, 'docs');
    mkdirSync(docs, { recursive: true });
    const edit = relaySandboxPaths(spec({ permission: 'edit', extraCwds: [docs] }), ctx, runDirs);
    expect(edit.allowWrite).toEqual(expect.arrayContaining([cwd, docs]));
    expect(edit.denyWrite).toEqual(expect.arrayContaining([join(cwd, '.cursor'), join(docs, '.cursor'), join(docs, '.clinerules'), join(docs, '.mcp.json')]));
    const ro = relaySandboxPaths(spec({ extraCwds: [docs] }), ctx, runDirs);
    expect(ro.allowWrite).not.toContain(docs);
    expect(ro.allowWrite).not.toContain(cwd);
  });

  it("lets a run read its own config and host temp inside the private roots, never another run's", () => {
    // Goose's layout: the member's config lives in its private state folder, beside other members'.
    const priv = join(dir, 'agent-home', 'goose', 'private');
    const mine = join(priv, 'conv.mine');
    const other = join(priv, 'conv.other');
    for (const d of [join(mine, 'data'), join(mine, 'config'), join(other, 'config')]) mkdirSync(d, { recursive: true });
    const root = join(data, 'relay-sandbox');
    const dirsIn = { tmp: join(root, 'r1'), hostTmp: join(root, 'r1.host') };
    const p = relaySandboxPaths(
      spec({ writable: [join(mine, 'data')], readOnly: [join(mine, 'config')], privateRoots: [priv, root] }),
      ctx,
      dirsIn,
    );
    // Its config is readable (it was hidden with the rest, so Goose said "Unknown provider"), still not writable.
    expect(p.allowRead).toContain(join(mine, 'config'));
    expect(p.denyWrite).toContain(join(mine, 'config'));
    expect(p.allowWrite).not.toContain(join(mine, 'config'));
    expect(p.allowRead).toContain(join(mine, 'data'));
    // The host's temp folder (sandbox-runtime's bridge sockets) when it is under the data folder.
    expect(p.allowRead).toContain(dirsIn.hostTmp);
    expect(p.allowRead).toContain(dirsIn.tmp);
    // Another member's folder stays hidden.
    expect(p.allowRead.some((x) => x.startsWith(other))).toBe(false);
    expect(p.denyRead).toEqual(expect.arrayContaining([priv, root]));
    // A protected path inside a private root is never re-opened.
    const p2 = relaySandboxPaths(spec({ readOnly: [join(mine, 'config')], protectedPaths: [join(mine, 'config')], privateRoots: [priv] }), ctx, dirsIn);
    expect(p2.allowRead).not.toContain(join(mine, 'config'));
  });

  it('lets read-only write only its temporary folder and the state folders', () => {
    const p = relaySandboxPaths(spec(), ctx, runDirs);
    expect(p.allowWrite).toContain(runDirs.tmp);
    expect(p.allowWrite).toContain(state);
    expect(p.allowWrite).not.toContain(cwd);
    expect(p.allowWrite).not.toContain(attachments);
    // Not the system's temporary folders, nor sandbox-runtime's shared one.
    expect(p.allowWrite).not.toContain(tmpdir());
    expect(p.denyWrite).toEqual(expect.arrayContaining(['/tmp/claude', '/private/tmp/claude', join(home, '.npm/_logs'), join(home, '.claude/debug')]));
    // The project's agent config is only kept in edit mode (in read-only the folder is not writable at all).
    expect(p.denyWrite).not.toContain(join(cwd, '.claude'));
  });

  it('lets edit also write the working directory and the attachments, but not the agent config in it', () => {
    const p = relaySandboxPaths(spec({ permission: 'edit' }), ctx, runDirs);
    expect(p.allowWrite).toEqual(expect.arrayContaining([runDirs.tmp, state, cwd, attachments]));
    for (const path of projectAgentConfig(cwd)) expect(p.denyWrite).toContain(path);
    expect(PROJECT_AGENT_CONFIG).toEqual(expect.arrayContaining(['.claude', '.codex', '.grok', '.cursor', '.opencode', 'opencode.json', '.pi', '.openhands']));
  });

  it("keeps Copilot's config in .github read-only only where .github exists, so that the folder can still be made", () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-agent-config-'));
    try {
      expect(projectAgentConfig(root)).toContain(join(root, '.claude'));
      expect(projectAgentConfig(root).some((p) => p.includes('.github'))).toBe(false);
      mkdirSync(join(root, '.github'));
      expect(projectAgentConfig(root)).toEqual(expect.arrayContaining([join(root, '.github/hooks'), join(root, '.github/copilot'), join(root, '.github/mcp.json')]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies reading and writing the protected paths, with the database and temporary folder in any case', () => {
    const p = relaySandboxPaths(spec({ protectedPaths: [browser] }), ctx, runDirs);
    for (const path of [browser, join(data, 'relay.db'), join(data, 'tmp')]) {
      expect(p.denyRead).toContain(path);
      expect(p.denyWrite).toContain(path);
    }
    // Files SQLite has not made are not listed (on Linux a deny would make them).
    expect(p.denyRead).not.toContain(join(data, 'relay.db-wal'));
  });

  it('keeps the config paths and the programs the run starts from being written', () => {
    const p = relaySandboxPaths(spec(), ctx, { ...runDirs, programs: ['/opt/agent/bin/opencode'] });
    expect(p.denyWrite).toContain(config);
    expect(p.denyWrite).toContain('/opt/agent/bin');
    expect(p.denyRead).not.toContain(config);
  });

  it('names a path also by its real path', () => {
    const link = join(dir, 'link-to-home');
    try {
      rmSync(link, { force: true });
      spawnSync('ln', ['-s', home, link]);
      const p = relaySandboxPaths(spec({ permission: 'edit', cwd: join(link, 'project') }), ctx, runDirs);
      expect(p.allowWrite).toEqual(expect.arrayContaining([join(link, 'project'), cwd]));
    } finally {
      rmSync(link, { force: true });
    }
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('relaySandboxConfig', () => {
  it('gives every path as a literal name, and closes the network around the proxy', () => {
    const paths = relaySandboxPaths(spec({ protectedPaths: [join(home, 'odd[1]')] }), ctx, runDirs);
    const hosts = relaySandboxHosts(['api.openai.com'], ctx);
    const c = relaySandboxConfig(paths, hosts, ctx);
    for (const list of [c.filesystem.denyRead, c.filesystem.allowWrite, c.filesystem.denyWrite]) {
      for (const entry of list) expect(entry).toEqual({ path: expect.any(String), literal: true });
    }
    expect(c.filesystem.allowRead).toEqual([]);
    expect(c.filesystem.allowGitConfig).toBe(false);
    expect(c.network.allowedDomains).toEqual(['api.openai.com']);
    expect(c.network.deniedDomains).toEqual(expect.arrayContaining(['localhost:8787', '127.0.0.1:8787', '[::1]:8787', '192.168.1.20:8787', 'localhost:5173']));
    expect(c.network.deniedDomainReasons?.['localhost:8787']).toBe(DENY_REASONS.relay);
    expect(c.network.allowLocalBinding).toBe(false);
    expect(c.network.allowAllUnixSockets).toBe(false);
    expect(c.network.allowUnixSockets).toEqual([]);
    expect(c.network.strictAllowlist).toBeUndefined(); // other hosts go to the ask callback
    expect(c.allowPty).toBe(false);
    expect(c.allowAppleEvents).toBe(false);
    expect(c.enableWeakerNestedSandbox).toBe(false);
    expect(c.allowNestedUserNamespaces).toBe(false);
    expect(c.bwrapPath).toBe('/usr/bin/bwrap');
    expect(c.socatPath).toBe('/usr/bin/socat');
    expect(c.ripgrep).toEqual({ command: '/usr/bin/rg' });
  });

  it('opts into a pty, the run\'s own unix sockets (macOS only) and the trustd service (macOS only)', () => {
    const paths = relaySandboxPaths(spec(), ctx, runDirs);
    const hosts = relaySandboxHosts(['api.openai.com'], ctx);
    const mac = { ...ctx, platform: 'darwin' as const, tools: { sh: '/bin/sh', bash: '/bin/bash' } };
    const cm = relaySandboxConfig(paths, hosts, mac, { allowPty: true, unixSocketDir: runDirs.tmp, allowTlsTrustd: true });
    expect(cm.allowPty).toBe(true);
    expect(cm.network.allowUnixSockets).toEqual([runDirs.tmp]);
    expect(cm.network.allowAllUnixSockets).toBe(false);
    expect(cm.network.allowMachLookup).toEqual(['com.apple.trustd.agent']);
    // On Linux a single unix socket cannot be allowed, and trustd is not a thing.
    const cl = relaySandboxConfig(paths, hosts, ctx, { allowPty: true, unixSocketDir: runDirs.tmp, allowTlsTrustd: true });
    expect(cl.allowPty).toBe(true);
    expect(cl.network.allowUnixSockets).toEqual([]);
    expect(cl.network.allowMachLookup).toBeUndefined();
    // Off by default.
    const off = relaySandboxConfig(paths, hosts, mac);
    expect(off.allowPty).toBe(false);
    expect(off.network.allowUnixSockets).toEqual([]);
    expect(off.network.allowMachLookup).toBeUndefined();
  });

  it('denies the quietly-denied hosts with a reason, winning over allow, never asked', () => {
    const hosts = relaySandboxHosts(['api.openai.com'], ctx, ['models.dev', 'api.openai.com']);
    expect(hosts.denied).toEqual(expect.arrayContaining(['models.dev', 'api.openai.com', 'localhost:8787']));
    expect(hosts.quietReasons['models.dev']).toBe(DENY_REASONS.quiet('models.dev'));
    const c = relaySandboxConfig(relaySandboxPaths(spec(), ctx, runDirs), hosts, ctx);
    expect(c.network.deniedDomainReasons?.['models.dev']).toBe(DENY_REASONS.quiet('models.dev'));
    // A denied host wins over the same host in the allow list.
    expect(c.network.deniedDomains).toContain('api.openai.com');
    expect(c.network.deniedDomainReasons?.['localhost:8787']).toBe(DENY_REASONS.relay);
  });

  it('names no Linux programs on macOS', () => {
    const c = relaySandboxConfig(relaySandboxPaths(spec(), ctx, runDirs), relaySandboxHosts([], ctx), { ...ctx, platform: 'darwin', tools: { sh: '/bin/sh', bash: '/bin/bash' } });
    expect(c.bwrapPath).toBeUndefined();
    expect(c.ripgrep).toBeUndefined();
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('connect-only ports', () => {
  it('are reached through the proxy by every loopback name, and never served', () => {
    expect(relaySandboxConnectPorts([7777, 7777])).toEqual(['localhost:7777']);
    expect(relaySandboxConnectPorts(undefined)).toEqual([]);
    for (const bad of [0, 70000, 1.5]) expect(() => relaySandboxConnectPorts([bad])).toThrow();
    const h = relaySandboxHosts(['api.openai.com', ...relaySandboxConnectPorts([7777])], ctx);
    expect(h.allowed).toEqual(expect.arrayContaining(['localhost:7777', '127.0.0.1:7777', '[::1]:7777']));
    // So loopback goes through the proxy (NO_PROXY no longer lists it).
    expect(h.loopback).toBe(true);
    // Never Harness Relay's own port.
    expect(() => relaySandboxHosts(relaySandboxConnectPorts([8787]), ctx)).toThrow(/Harness Relay/);
    // A port cannot be both served and connect-only.
    expect(() => relaySandboxLocalPorts([7777], ctx, h.allowed)).toThrow();
  });

  it('are not handed to the host as ports to listen on', async () => {
    const s = await sandboxCommand('/bin/sh', ['-c', 'true'], { PATH: '/usr/bin:/bin' }, spec({ connectPorts: [7777], localPorts: [4096] }), {
      ctx: { ...ctx, platform: 'darwin', tools: { sh: '/bin/sh', bash: '/bin/bash' } },
      available: async () => ({ ok: true }),
    });
    const { server, host } = channelPair();
    s.run.attach(server, {} as never);
    await until(() => host.lines.length > 0);
    const config = JSON.parse(host.lines[0]!);
    expect(config.localPorts).toEqual([4096]);
    expect(config.srt.network.allowedDomains).toEqual(expect.arrayContaining(['127.0.0.1:7777', '127.0.0.1:4096']));
    await s.dispose();
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('host names that lead to this computer', () => {
  it('are never looked up by the server: a name is asked about like any other (sandbox-runtime refuses a local one when it dials)', async () => {
    const asked: string[] = [];
    const { run, host } = newRun(async (req) => (asked.push(req.detail!), { allow: false }));
    host.write({ t: 'ask', id: 1, host: 'localtest.me', port: 8787 });
    host.write({ t: 'ask', id: 2, host: 'c2VjcmV0.exfil.example', port: 443 });
    host.write({ t: 'ask', id: 3, host: '127.0.0.1', port: 8787 });
    await until(() => answers(host.lines).length === 3);
    const byId = Object.fromEntries(answers(host.lines).map((m) => [m.id, m]));
    // A literal local address is refused without asking; names go to the user, never to a resolver.
    expect(byId[3]).toEqual({ t: 'answer', id: 3, allow: false, reason: DENY_REASONS.local('127.0.0.1:8787') });
    // (Named as the proxy dials them: in lower case.)
    expect([...asked].sort()).toEqual(['c2vjcmv0.exfil.example', 'localtest.me:8787']);
    await run.dispose();
  });

  it('are refused without any lookup in a conversation that refuses automatically', async () => {
    const { run, host } = newRun(undefined);
    for (let id = 1; id <= 5; id++) host.write({ t: 'ask', id, host: `n${id}.exfil.example`, port: 443 });
    await until(() => answers(host.lines).length === 5);
    expect(answers(host.lines).every((m) => m.allow === false)).toBe(true);
    await run.dispose();
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('hosts', () => {
  it('reads host and host:port entries, and nothing else', () => {
    expect(parseHostEntry('api.openai.com')).toEqual({ host: 'api.openai.com' });
    expect(parseHostEntry('API.x.ai:443')).toEqual({ host: 'api.x.ai', port: 443 });
    expect(parseHostEntry('[::1]:11434')).toEqual({ host: '[::1]', port: 11434 });
    expect(parseHostEntry('10.0.0.5:8000')).toEqual({ host: '10.0.0.5', port: 8000 });
    expect(parseHostEntry('*.example.com')).toEqual({ host: '*.example.com' });
    for (const bad of ['https://api.openai.com', 'api.openai.com/v1', 'a b', 'host:0', 'host:70000', 'user@host', '', '::1', 'a..b', '-a.com']) {
      expect(parseHostEntry(bad)).toBeUndefined();
    }
  });

  it('tells loopback and local destinations, in every spelling', () => {
    for (const h of ['localhost', 'LOCALHOST', 'x.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:127.0.0.1]']) {
      expect(isLoopbackHost(h)).toBe(true);
      expect(isLocalHost(h)).toBe(true);
    }
    for (const h of ['0.0.0.0', '::', '169.254.169.254', 'fe80::1%en0', 'fe80::abcd', 'ff02::1', '224.0.0.1', '255.255.255.255', '100.100.100.200', '168.63.129.16', 'fd00:ec2::254', '64:ff9b::a9fe:a9fe', '::ffff:169.254.169.254']) {
      expect(isLocalHost(h)).toBe(true);
    }
    for (const h of ['api.openai.com', '192.168.1.30', '10.0.0.5', '100.64.1.2', '2001:db8::1', 'fd00::1']) expect(isLocalHost(h)).toBe(false);
    // This computer's own addresses, also as an IPv4-carrying IPv6 address.
    expect(isLocalHost('192.168.1.20', ctx.localAddresses)).toBe(true);
    expect(isLocalHost('::ffff:192.168.1.20', ctx.localAddresses)).toBe(true);
    // A name with its trailing dot is the same name.
    expect(isLoopbackHost('localhost.')).toBe(true);
    expect(ipv6Groups('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('1::2::3')).toBeUndefined();
    expect(ipv6Groups('example.com')).toBeUndefined();
  });

  it('reads a host as the proxy dials it: the other spellings of an address are that address', () => {
    const spelled: [string, string][] = [
      ['127.1', '127.0.0.1'],
      ['2130706433', '127.0.0.1'],
      ['0x7f.0.0.1', '127.0.0.1'],
      ['0177.0.0.1', '127.0.0.1'],
      ['127.0.0.1.', '127.0.0.1'],
      ['0', '0.0.0.0'],
      ['2852039166', '169.254.169.254'],
      ['0xa9.0xfe.0xa9.0xfe', '169.254.169.254'],
      ['localhost.', 'localhost'],
      ['LocalHost', 'localhost'],
      ['[::ffff:127.0.0.1]', '::ffff:7f00:1'],
      ['API.OpenAI.com.', 'api.openai.com'],
    ];
    for (const [given, canonical] of spelled) {
      expect(canonicalHost(given)).toBe(canonical);
      expect(isLocalHost(canonicalHost(given)!)).toBe(!canonical.startsWith('api.'));
    }
    for (const bad of ['', 'a b', 'fe80::1%en0x', 'a/b', 'user@host', 'a?b', '[::1']) expect(canonicalHost(bad)).toBeUndefined();
  });

  it('allows the backends, by each loopback name for one on loopback', () => {
    const h = relaySandboxHosts(['api.anthropic.com', 'homelab.example:8000', 'localhost:11434', '192.168.1.20:1234'], ctx);
    expect(h.allowed).toEqual(['api.anthropic.com', 'homelab.example:8000', 'localhost:11434', '127.0.0.1:11434', '[::1]:11434', '192.168.1.20:1234']);
    expect(h.loopback).toBe(true);
    expect(relaySandboxHosts(['api.anthropic.com'], ctx).loopback).toBe(false);
  });

  it('refuses a local backend without a port, one at Harness Relay\'s port, and entries it cannot read', () => {
    expect(() => relaySandboxHosts(['localhost'], ctx)).toThrow(/port|連接埠/);
    expect(() => relaySandboxHosts(['127.0.0.1:8787'], ctx)).toThrow(/Harness Relay/);
    expect(() => relaySandboxHosts(['[::1]:5173'], ctx)).toThrow(/Harness Relay/);
    expect(() => relaySandboxHosts(['192.168.1.20:8787'], ctx)).toThrow(/Harness Relay/);
    for (const bad of ['*', '*.com', 'https://api.openai.com']) expect(() => relaySandboxHosts([bad], ctx)).toThrow();
    withLang('en', () => expect(() => relaySandboxHosts(['localhost:8787'], ctx)).toThrow("is Harness Relay's own port"));
  });

  it('takes the agent\'s own loopback ports, never Harness Relay\'s, never an out-of-range one', () => {
    expect(relaySandboxLocalPorts([4096, 55000], ctx)).toEqual([4096, 55000]);
    expect(relaySandboxLocalPorts(undefined, ctx)).toEqual([]);
    expect(() => relaySandboxLocalPorts([8787], ctx)).toThrow(/Harness Relay/);
    expect(() => relaySandboxLocalPorts([80], ctx)).toThrow();
    expect(() => relaySandboxLocalPorts([70000], ctx)).toThrow();
    // A loopback backend's port is the backend's, never the agent's own as well.
    expect(() => relaySandboxLocalPorts([11434], ctx, relaySandboxHosts(['localhost:11434'], ctx).allowed)).toThrow();
    expect(relaySandboxLocalPorts([4096], ctx, relaySandboxHosts(['localhost:11434'], ctx).allowed)).toEqual([4096]);
  });

  it("lets the agent's own ports through the proxy on macOS only, next to a loopback backend, nothing else local", () => {
    const paths = relaySandboxPaths(spec(), ctx, runDirs);
    const hosts = relaySandboxHosts(['127.0.0.1:11434'], ctx);
    const mac = { ...ctx, platform: 'darwin' as const, tools: { sh: '/bin/sh', bash: '/bin/bash' } };
    const cm = relaySandboxConfig(paths, hosts, mac, { localPorts: [4096] });
    expect(cm.network.allowedDomains).toEqual(
      expect.arrayContaining(['127.0.0.1:11434', 'localhost:11434', '[::1]:11434', '127.0.0.1:4096', 'localhost:4096', '[::1]:4096']),
    );
    // Only those ports: no bare loopback name, no other port, and Harness Relay's stay denied.
    for (const entry of cm.network.allowedDomains) expect(entry).toMatch(/:(11434|4096)$/);
    expect(cm.network.deniedDomains).toEqual(expect.arrayContaining(['127.0.0.1:8787', 'localhost:8787']));
    // On Linux the sandbox's loopback is its own: the proxy would reach this computer's port 4096.
    const cl = relaySandboxConfig(paths, hosts, ctx, { localPorts: [4096] });
    expect(cl.network.allowedDomains).toEqual(hosts.allowed);
    expect(cl.network.allowedDomains.some((d) => d.endsWith(':4096'))).toBe(false);
  });

  it("takes Harness Relay's ports from PORT, and npm run dev's and Vite's", () => {
    expect(relayPorts({ PORT: '9000' })).toEqual([9000, 8787, 8789, 5173]);
    expect(relayPorts({})).toEqual([8787, 8789, 5173]);
    expect(relayPorts({ npm_lifecycle_event: 'dev' })).toEqual([8789, 8787, 5173]);
  });

  it('takes the port the server got too, when PORT=0 let it pick a free one', () => {
    expect(relayPorts({ PORT: '0' }, 51234)).toEqual([51234, 8787, 8789, 5173]);
    expect(relayPorts({ PORT: '9000' }, 9000)).toEqual([9000, 8787, 8789, 5173]);
    expect(relayPorts({ PORT: '0' }, undefined)).toEqual([8787, 8789, 5173]);
  });

  it('labels a host as approvals key it, host alone for 443 and 80', () => {
    expect(hostLabel('example.com', 443)).toBe('example.com');
    expect(hostLabel('example.com', 8080)).toBe('example.com:8080');
    expect(hostLabel('::1', 22)).toBe('[::1]:22');
    // Keyed by host and port: allowing one port of a host allows no other.
    expect(approvalKeys('fetch', 'example.com:8080')).toEqual(['example.com:8080']);
    expect(approvalKeys('fetch', '[2001:db8::1]:22')).toEqual(['[2001:db8::1]:22']);
    expect(approvalKeys('fetch', 'example.com:443')).toEqual(['example.com']);
    expect(approvalKeys('fetch', 'https://docs.example.com/page')).toEqual(['docs.example.com']);
    expect(approvalKeys('fetch', 'example.com')).toEqual(['example.com']);
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('relaySandboxRefusal', () => {
  it('passes a well-formed spec', () => {
    expect(relaySandboxRefusal(spec(), ctx)).toBeUndefined();
    expect(relaySandboxRefusal(spec({ permission: 'edit' }), ctx)).toBeUndefined();
  });

  it('refuses relative paths and protected or config paths a sandbox would read as patterns', () => {
    expect(relaySandboxRefusal(spec({ writable: ['state'] }), ctx)).toMatch(/state/);
    expect(relaySandboxRefusal(spec({ protectedPaths: [join(home, 'Profiles*')] }), ctx)).toMatch(/Profiles\*/);
    expect(relaySandboxRefusal(spec({ readOnly: [join(home, 'conf[1].json')] }), ctx)).toMatch(/conf\[1\]/);
  });

  it("names voice input's folder when a folder the run may write overlaps it", () => {
    const voice = join(dir, 'voice-elsewhere');
    expect(relaySandboxRefusal(spec({ writable: [join(voice, 'models')] }), { ...ctx, voiceDir: voice })).toContain(voice);
    expect(relaySandboxRefusal(spec({ writable: [join(voice, 'models')] }), { ...ctx, voiceDir: voice })).not.toContain(ctx.relayRoot);
  });

  it('refuses edit mode in Harness Relay or the home folder, but not read-only', () => {
    expect(relaySandboxRefusal(spec({ permission: 'edit', cwd: RELAY_ROOT }), ctx)).toBeDefined();
    expect(relaySandboxRefusal(spec({ permission: 'edit', cwd: homedir() }), ctx)).toBeDefined();
    expect(relaySandboxRefusal(spec({ permission: 'read-only', cwd: homedir() }), ctx)).toBeUndefined();
    // Any of the conversation's working directories, not only the first.
    expect(relaySandboxRefusal(spec({ permission: 'edit', extraCwds: [RELAY_ROOT] }), ctx)).toBeDefined();
    expect(relaySandboxRefusal(spec({ permission: 'edit', extraCwds: [homedir()] }), ctx)).toBeDefined();
    expect(relaySandboxRefusal(spec({ permission: 'edit', extraCwds: ['docs'] }), ctx)).toMatch(/docs/);
    expect(relaySandboxRefusal(spec({ permission: 'read-only', extraCwds: [homedir()] }), ctx)).toBeUndefined();
  });

  it('refuses a writable folder that holds the home folder, Harness Relay, or another CLI\'s folder', () => {
    expect(relaySandboxRefusal(spec({ writable: [join(dir, 'home')] }), ctx)).toContain(home);
    expect(relaySandboxRefusal(spec({ writable: [dir] }), ctx)).toBeDefined();
    expect(relaySandboxRefusal(spec({ writable: [join(ctx.relayRoot, 'node_modules')] }), ctx)).toBeDefined();
    // Claude Code's, Codex's and Grok's own folders (where their variables put them).
    for (const folder of agentFolders({ home })) {
      expect(relaySandboxRefusal(spec({ writable: [folder] }), ctx)).toBeDefined();
      expect(relaySandboxRefusal(spec({ writable: [join(folder, 'sessions')] }), ctx)).toBeDefined();
    }
    // Inside the data folder (attachments, parallel worktrees) is fine; holding it is not.
    expect(relaySandboxRefusal(spec({ writable: [join(data, 'worktrees', 'x')] }), ctx)).toBeUndefined();
    expect(relaySandboxRefusal(spec({ writable: [data] }), ctx)).toBeDefined();
  });

  it('refuses when a program run outside the sandbox is in a folder the run may write', () => {
    expect(relaySandboxRefusal(spec(), ctx, { programs: [join(state, 'bin', 'bwrap')] })).toMatch(/bwrap/);
    expect(relaySandboxRefusal(spec({ permission: 'edit' }), ctx, { programs: [join(cwd, 'node_modules', '.bin', 'x')] })).toBeDefined();
    expect(relaySandboxRefusal(spec(), ctx, { programs: [join(cwd, 'node_modules', '.bin', 'x')] })).toBeUndefined();
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('relaySandboxEnv', () => {
  const env = {
    PATH: '/agent/bin:/usr/bin',
    HOME: home,
    OPENAI_API_KEY: 'sk-test',
    LD_PRELOAD: '/x/evil.so',
    BASH_ENV: '/x/env.sh',
    HTTPS_PROXY: 'http://corp:3128',
    NO_PROXY: '*',
    TMPDIR: '/tmp',
  };

  it('starts the sandbox with a clean environment and gives the agent its own inside', () => {
    const { outerEnv, command } = relaySandboxEnv('/opt/bin/agent', ['--mode', 'rpc'], env, { tmp: '/r/tmp', loopback: false });
    expect(outerEnv.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(outerEnv.LD_PRELOAD).toBeUndefined();
    expect(outerEnv.BASH_ENV).toBeUndefined();
    expect(outerEnv.HTTPS_PROXY).toBeUndefined();
    expect(outerEnv.NO_PROXY).toBeUndefined();
    expect(outerEnv.OPENAI_API_KEY).toBe('sk-test');
    // The command is fixed text: no path, name or setting in it (AGENTS.md); they travel in the environment.
    expect(command).toBe(SANDBOX_EXEC_SCRIPT);
    expect(command).not.toContain('/opt/bin/agent');
    expect(command).not.toContain('/agent/bin');
    expect(outerEnv).toMatchObject({
      [`${SANDBOX_EXEC_PREFIX}IN_PATH`]: '/agent/bin:/usr/bin',
      [`${SANDBOX_EXEC_PREFIX}IN_LD_PRELOAD`]: '/x/evil.so',
      [`${SANDBOX_EXEC_PREFIX}IN_NODE_USE_ENV_PROXY`]: '1',
      [`${SANDBOX_EXEC_PREFIX}IN_TMPDIR`]: '/r/tmp',
      [`${SANDBOX_EXEC_PREFIX}ARG_0`]: '/opt/bin/agent',
      [`${SANDBOX_EXEC_PREFIX}ARG_1`]: '--mode',
      [`${SANDBOX_EXEC_PREFIX}ARG_2`]: 'rpc',
      [`${SANDBOX_EXEC_PREFIX}ARGC`]: '3',
    });
    expect(Object.values(outerEnv).join(' ')).not.toContain('corp:3128');
    // Run, the script sets the inner variables again and leaves none of its own behind.
    const r = spawnSync('/bin/sh', ['-c', relaySandboxEnv('/usr/bin/env', [], env, { tmp: '/r/tmp', loopback: false }).command], {
      env: relaySandboxEnv('/usr/bin/env', [], env, { tmp: '/r/tmp', loopback: false }).outerEnv,
      encoding: 'utf8',
    });
    const inside = r.stdout.split('\n');
    expect(inside).toContain('PATH=/agent/bin:/usr/bin');
    expect(inside).toContain('LD_PRELOAD=/x/evil.so');
    expect(inside.filter((l) => l.startsWith(SANDBOX_EXEC_PREFIX))).toEqual([]);
    // A value that is not a string never reaches a command line.
    expect(() => relaySandboxEnv('/bin/sh', [42 as unknown as string], env, { tmp: '/r/tmp', loopback: false })).toThrow(TypeError);
  });

  it('keeps only loopback out of the proxy, and only the agent\'s own ports when a backend is on loopback', () => {
    const run = (loopback: boolean, localPorts?: number[]) => {
      const { outerEnv, command } = relaySandboxEnv('/usr/bin/env', [], { PATH: '/usr/bin:/bin' }, { tmp: '/r/tmp', loopback, localPorts });
      const r = spawnSync('/bin/sh', ['-c', command], { env: { ...outerEnv, NO_PROXY: 'localhost,10.0.0.0/8,192.168.0.0/16' }, encoding: 'utf8' });
      return Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    };
    // sandbox-runtime's own NO_PROXY (private ranges too) would send a LAN backend around the proxy.
    expect(run(false).NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(run(false).no_proxy).toBe('localhost,127.0.0.1,::1');
    // Without a loopback backend the agent's own ports are covered by plain loopback.
    expect(run(false, [4096]).NO_PROXY).toBe('localhost,127.0.0.1,::1');
    // A loopback backend goes through the proxy; nothing else on loopback is let around it...
    expect(run(true).NO_PROXY).toBe('');
    // ...but the agent's own server is (OpenCode with Ollama on 127.0.0.1), by port, and never [::1]:port,
    // which makes httpx refuse the whole variable.
    expect(run(true, [4096, 5000]).NO_PROXY).toBe('127.0.0.1:4096,localhost:4096,127.0.0.1:5000,localhost:5000');
    expect(run(true, [4096]).no_proxy).toBe('127.0.0.1:4096,localhost:4096');
    expect(run(true, [4096]).NO_PROXY).not.toContain('[');
    expect(run(true).TMPDIR).toBe('/r/tmp');
    expect(run(true).TEMP).toBe('/r/tmp');
    expect(run(true).NODE_USE_ENV_PROXY).toBe('1');
  });

  it("relays the loopback ports the run may reach onto the sandbox's own loopback, through the proxy (Linux)", async () => {
    // A stand-in socat that says what it was asked to do, one line each (the relays start side by side),
    // and listens on an IPv4 port it is given for a moment, so the script sees it up (Linux) and goes on.
    const log = join(dir, 'socat.log');
    rmSync(log, { force: true });
    const socat = join(dir, 'fake-socat');
    writeFileSync(
      socat,
      `#!${process.execPath}\nconst a = process.argv.slice(2);\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, a.join('|') + '|\\n');\n` +
        `const m = /^TCP4-LISTEN:(\\d+)/.exec(a[0] ?? '');\nif (m) { const s = require('node:net').createServer().listen(Number(m[1]), '127.0.0.1'); setTimeout(() => s.close(), 3000); }\n`,
      { mode: 0o755 },
    );
    const [p1, p2] = [await freeLoopbackPort(), await freeLoopbackPort()].sort((a, b) => a - b);
    const { outerEnv, command } = relaySandboxEnv('/usr/bin/env', [], { PATH: '/usr/bin:/bin' }, { tmp: '/r/tmp', loopback: true, loopbackRelay: { socat, ports: [p1, p2] } });
    expect(command).toBe(SANDBOX_EXEC_SCRIPT); // still fixed text: the ports and socat's path are in the environment
    expect(outerEnv).toMatchObject({ [`${SANDBOX_EXEC_PREFIX}RELAY_PORTS`]: `${p1} ${p2}`, [`${SANDBOX_EXEC_PREFIX}SOCAT`]: socat });
    // sandbox-runtime's proxy, with the run's own credentials, percent-encoded as it gives them.
    const proxy = 'http://srt.aGk%3D:t0k%2Ben@localhost:3128';
    const r = spawnSync('/bin/sh', ['-c', command], { env: { ...outerEnv, HTTP_PROXY: proxy }, encoding: 'utf8' });
    const inside = r.stdout.split('\n');
    expect(inside.filter((l) => l.startsWith(SANDBOX_EXEC_PREFIX))).toEqual([]);
    const until = Date.now() + 5000;
    while (Date.now() < until && (!existsSync(log) || readFileSync(log, 'utf8').trim().split('\n').length < 4)) spawnSync('/bin/sleep', ['0.05']);
    const calls = readFileSync(log, 'utf8').trim().split('\n').sort();
    const relay = (listen: string, port: number) => `${listen}|PROXY:localhost:127.0.0.1:${port},proxyport=3128,proxyauth=srt.aGk=:t0k+en|`;
    expect(calls).toEqual(
      [
        relay(`TCP4-LISTEN:${p1},bind=127.0.0.1,fork,reuseaddr`, p1),
        relay(`TCP4-LISTEN:${p2},bind=127.0.0.1,fork,reuseaddr`, p2),
        relay(`TCP6-LISTEN:${p1},bind=[::1],ipv6only=1,fork,reuseaddr`, p1),
        relay(`TCP6-LISTEN:${p2},bind=[::1],ipv6only=1,fork,reuseaddr`, p2),
      ].sort(),
    );
    // Nothing is relayed without ports, or without a proxy to go through.
    expect(relaySandboxEnv('/usr/bin/env', [], { PATH: '/usr/bin:/bin' }, { tmp: '/r/tmp', loopback: true, loopbackRelay: { socat, ports: [] } }).outerEnv[`${SANDBOX_EXEC_PREFIX}RELAY_PORTS`]).toBeUndefined();
    expect(relaySandboxEnv('/usr/bin/env', [], { PATH: '/usr/bin:/bin' }, { tmp: '/r/tmp', loopback: true }).outerEnv[`${SANDBOX_EXEC_PREFIX}RELAY_PORTS`]).toBeUndefined();
    // The loopback ports come from the run's hosts: a backend on loopback and the ports it only connects to.
    expect(relaySandboxHosts(['api.openai.com', 'localhost:11434', '[::1]:8000', 'localhost:11434'], ctx).loopbackPorts).toEqual([11434, 8000]);
    expect(relaySandboxHosts(['api.openai.com', '192.168.1.20:1234'], ctx).loopbackPorts).toEqual([]);
  });

  it('quotes the command so a shell runs exactly it', () => {
    const script = join(dir, 'argv.sh');
    writeFileSync(script, '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n');
    chmodSync(script, 0o755);
    const args = [`it's`, '$(touch pwned)', 'a b', '`id`', '"q"', ''];
    const { outerEnv, command } = relaySandboxEnv(script, args, { PATH: '/usr/bin:/bin' }, { tmp: dir, loopback: false });
    const r = spawnSync('/bin/sh', ['-c', command], { env: outerEnv, cwd: dir, encoding: 'utf8' });
    expect(r.stdout).toBe(args.map((a) => `[${a}]\n`).join(''));
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`);
  });
});

/** The server's end of a host's channel, and what the host reads from it and writes to it. */
function channelPair(): { server: Duplex; host: { lines: string[]; write(msg: unknown): void; end(): void } } {
  const lines: string[] = [];
  let buf = '';
  const server = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, done) {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      done();
    },
  });
  return { server, host: { lines, write: (msg) => server.push(`${JSON.stringify(msg)}\n`), end: () => server.push(null) } };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
}

function newRun(requestApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>) {
  const dirs = makeRunDirs(data);
  const run = new RelaySandboxRun(dirs, { srt: { marker: 1 } }, { requestApproval, localAddresses: ctx.localAddresses, platform: 'linux', arch: 'x64' });
  const { server, host } = channelPair();
  run.attach(server, {} as never);
  return { run, host, dirs };
}

const answers = (lines: string[]) => lines.map((l) => JSON.parse(l)).filter((m) => m.t === 'answer');

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('disposing of a run whose leftovers survive', () => {
  const disposeWith = async (bySandbox: boolean, byMarker: boolean) => {
    const dirs = makeRunDirs(data);
    const run = new RelaySandboxRun(dirs, {}, {
      localAddresses: ctx.localAddresses,
      platform: 'darwin',
      arch: 'arm64',
      sweeps: { bySandbox: async () => bySandbox, byMarker: async () => byMarker },
    });
    await run.dispose();
    return { tmp: existsSync(dirs.tmp), marker: existsSync(dirs.marker!), host: existsSync(dirs.hostTmp) };
  };
  it.runIf(process.platform === 'darwin')('keeps the marker and the temp folder for the next start when something is left (or a sweep could not tell)', async () => {
    expect(await disposeWith(true, true)).toEqual({ tmp: false, marker: false, host: false });
    expect(await disposeWith(false, true)).toEqual({ tmp: true, marker: true, host: false });
    expect(await disposeWith(true, false)).toEqual({ tmp: true, marker: true, host: false });
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('RelaySandboxRun', () => {
  it('sends the run its rules first, over its own channel only', async () => {
    const { run, host } = newRun();
    await until(() => host.lines.length > 0);
    expect(JSON.parse(host.lines[0]!)).toEqual({ t: 'config', srt: { marker: 1 } });
    // A second process that got the same env (and so the channel) is cut off.
    const other = channelPair();
    let closed = false;
    other.server.on('close', () => (closed = true));
    run.attach(other.server, {} as never);
    await until(() => closed);
    expect(closed).toBe(true);
    await run.dispose();
  });

  it('tells its listeners when the host says the command exited, and a later one at once', async () => {
    const { run, host } = newRun();
    const seen: string[] = [];
    run.onExit(() => seen.push('first'));
    host.write({ t: 'exit', code: 1, signal: null });
    await until(() => seen.length === 1);
    expect(run.exit).toEqual({ code: 1, signal: null });
    run.onExit(() => seen.push('later'));
    expect(seen).toEqual(['first', 'later']);
    await run.dispose();
  });

  it("asks this run's requestApproval about a host, once, and answers with the reason the model sees", async () => {
    const asked: ApprovalRequest[] = [];
    const { run, host } = newRun(async (req) => {
      asked.push(req);
      return { allow: false, note: 'use the docs instead' };
    });
    host.write({ t: 'ask', id: 1, host: 'example.org', port: 443 });
    host.write({ t: 'ask', id: 2, host: 'example.org', port: 443 });
    await until(() => answers(host.lines).length === 2);
    expect(asked).toEqual([{ kind: 'fetch', detail: 'example.org', reason: expect.any(String) }]);
    expect(answers(host.lines)).toEqual([
      { t: 'answer', id: 1, allow: false, reason: DENY_REASONS.declined('example.org', 'use the docs instead') },
      { t: 'answer', id: 2, allow: false, reason: DENY_REASONS.declined('example.org', 'use the docs instead') },
    ]);
    await run.dispose();
  });

  it('allows a host the user allows, with its port in the request when it is not 443', async () => {
    const asked: ApprovalRequest[] = [];
    const { run, host } = newRun(async (req) => {
      asked.push(req);
      return { allow: true };
    });
    host.write({ t: 'ask', id: 7, host: 'registry.example', port: 8443 });
    await until(() => answers(host.lines).length === 1);
    expect(asked[0]!.detail).toBe('registry.example:8443');
    expect(answers(host.lines)).toEqual([{ t: 'answer', id: 7, allow: true }]);
    await run.dispose();
  });

  it('refuses this computer, and every host when the conversation refuses, without asking', async () => {
    let calls = 0;
    const a = newRun(async () => {
      calls++;
      return { allow: true };
    });
    a.host.write({ t: 'ask', id: 1, host: '127.0.0.1', port: 8787 });
    a.host.write({ t: 'ask', id: 2, host: '169.254.169.254', port: 80 });
    a.host.write({ t: 'ask', id: 3, host: '192.168.1.20', port: 22 });
    await until(() => answers(a.host.lines).length === 3);
    expect(calls).toBe(0);
    expect(answers(a.host.lines).map((m) => m.reason)).toEqual([
      DENY_REASONS.local('127.0.0.1:8787'),
      DENY_REASONS.local('169.254.169.254'),
      DENY_REASONS.local('192.168.1.20:22'),
    ]);
    const b = newRun(undefined);
    b.host.write({ t: 'ask', id: 1, host: 'example.org', port: 443 });
    await until(() => answers(b.host.lines).length === 1);
    expect(answers(b.host.lines)[0]).toEqual({ t: 'answer', id: 1, allow: false, reason: DENY_REASONS.refused('example.org') });
    await a.run.dispose();
    await b.run.dispose();
  });

  it('keeps two runs apart: each ask goes to its own run', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const a = newRun(async (req) => (seenA.push(req.detail!), { allow: true }));
    const b = newRun(async (req) => (seenB.push(req.detail!), { allow: false }));
    a.host.write({ t: 'ask', id: 1, host: 'a.example', port: 443 });
    b.host.write({ t: 'ask', id: 1, host: 'b.example', port: 443 });
    await until(() => answers(a.host.lines).length === 1 && answers(b.host.lines).length === 1);
    expect(seenA).toEqual(['a.example']);
    expect(seenB).toEqual(['b.example']);
    expect(answers(a.host.lines)[0].allow).toBe(true);
    expect(answers(b.host.lines)[0].allow).toBe(false);
    // What one run was allowed is not the other's.
    b.host.write({ t: 'ask', id: 2, host: 'a.example', port: 443 });
    await until(() => answers(b.host.lines).length === 2);
    expect(seenB).toEqual(['b.example', 'a.example']);
    await a.run.dispose();
    await b.run.dispose();
  });

  it('refuses without asking every spelling of a local address, and asks about a name by the name it dials', async () => {
    const seen: string[] = [];
    const { run, host } = newRun(async (req) => (seen.push(req.detail!), { allow: true }));
    const local = ['127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '127.0.0.1.', 'localhost.', '0', '2852039166', '[::ffff:169.254.169.254]'];
    local.forEach((h, i) => host.write({ t: 'ask', id: i + 1, host: h, port: 8000 }));
    await until(() => answers(host.lines).length === local.length);
    for (const a of answers(host.lines)) {
      expect(a.allow).toBe(false);
      expect(a.reason).toMatch(/this computer's own addresses or link-local addresses/);
    }
    expect(seen).toEqual([]);
    // A name is asked about once, whatever its letter case or trailing dot.
    host.write({ t: 'ask', id: 50, host: 'Example.ORG.', port: 443 });
    host.write({ t: 'ask', id: 51, host: 'example.org', port: 443 });
    await until(() => answers(host.lines).length === local.length + 2);
    expect(seen).toEqual(['example.org']);
    await run.dispose();
  });

  it('asks one host at a time, and stops asking after too many', async () => {
    let open = 0;
    let most = 0;
    const { run, host } = newRun(async () => {
      most = Math.max(most, ++open);
      await tick();
      open--;
      return { allow: false };
    });
    for (let i = 1; i <= 32; i++) host.write({ t: 'ask', id: i, host: `h${i}.example`, port: 443 });
    await until(() => answers(host.lines).length === 32);
    expect(most).toBe(1);
    const last = answers(host.lines).filter((m) => m.reason === DENY_REASONS.tooMany(`h${m.id}.example`));
    expect(last.map((m) => m.id)).toEqual([31, 32]);
    await run.dispose();
  });

  it('refuses when asking fails, and after the run is over', async () => {
    const { run, host } = newRun(async () => {
      throw new Error('gone');
    });
    host.write({ t: 'ask', id: 1, host: 'example.org', port: 443 });
    await until(() => answers(host.lines).length === 1);
    expect(answers(host.lines)[0].allow).toBe(false);
    await run.dispose();
    await expect(run.decide('late.example', 443)).resolves.toEqual({ allow: false, reason: DENY_REASONS.refused('late.example') });
  });

  it('reports why the sandbox did not start, in the language asked for', async () => {
    const { run, host } = newRun();
    host.write({ t: 'failed', code: 'init', detail: 'bwrap: setting up uid map: Permission denied' });
    await until(() => run.hostFailure() !== undefined);
    expect(withLang('en', () => run.failure())).toMatch(/^Harness Relay's own sandbox could not start .*uid map.*AppArmor/);
    expect(withLang('zh-TW', () => run.failure())).toMatch(/Harness Relay 自己的沙箱無法啟動.*uid map/);
    await run.dispose();
    const never = new RelaySandboxRun(makeRunDirs(data), {}, { localAddresses: [], platform: 'linux', arch: 'x64' });
    expect(withLang('en', () => never.failure())).toMatch(/control channel/);
    await never.dispose();
  });

  it('removes its folders and closes its channel when disposed', async () => {
    const { run, dirs } = newRun();
    writeFileSync(join(dirs.tmp, 'left'), 'x');
    expect(statSync(dirs.tmp).mode & 0o777).toBe(0o700);
    await run.dispose();
    expect(existsSync(dirs.tmp)).toBe(false);
    expect(existsSync(dirs.hostTmp)).toBe(false);
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('run folders and their markers', () => {
  it("keeps the host's temp folder in the data folder, and refuses a data folder too long for its sockets", async () => {
    const d = makeRunDirs(data);
    expect(dirname(d.hostTmp)).toBe(relaySandboxHostRoot(data));
    expect(statSync(d.hostTmp).mode & 0o777).toBe(0o700);
    for (const platform of ['darwin', 'linux'] as const) expect(d.hostTmp.length).toBeLessThanOrEqual(HOST_TMP_MAX[platform]!);
    // The startup sweep removes a host's folder a stopped run left, with the run's own.
    writeFileSync(join(d.hostTmp, 'srt.sock'), '');
    clearRelaySandboxLeftovers(data, 'linux');
    for (const p of [d.tmp, d.hostTmp, d.marker!]) expect(existsSync(p)).toBe(false);
    // Never in the system's temp folder, where another CLI's sandboxed command could change it: refused.
    const long = join(dir, 'a-data-folder-with-a-name-long-enough-for-its-sockets-to-be-too-long');
    for (const platform of ['darwin', 'linux'] as const) {
      expect(() => withLang('en', () => makeRunDirs(long, platform))).toThrow(/too long for the sockets its sandbox makes there.*RELAY_DATA_DIR/);
    }
    expect(withLang('zh-TW', () => {
      try {
        makeRunDirs(long, 'linux');
      } catch (err) {
        return (err as Error).message;
      }
    })).toMatch(/太長.*RELAY_DATA_DIR/);
    expect(existsSync(long)).toBe(false);
    // Other systems are refused elsewhere (`sandboxAvailable`), so no limit applies here.
    removeRunDirs(makeRunDirs(join(dir, 'other-system'), 'freebsd'));
    // Told before any sandbox is tried, as the other reasons the sandbox cannot work here are.
    const tools = { sh: '/bin/sh', bash: '/bin/bash', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: '/usr/bin/rg' };
    await expect(withLang('en', () => sandboxAvailable({ ...ctx, platform: 'linux', arch: 'x64', tools, dataDir: long }))).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/too long for the sockets.*at most 61 bytes/),
    });
    expect(existsSync(long)).toBe(false);
    // Counted in bytes, as a socket's path is: a path in Chinese fits in characters, not in bytes.
    const fits = HOST_TMP_MAX.darwin! - '/srt/'.length - 6; // 70, in characters as in bytes for ASCII
    const chinese = join(dir, '資料'.repeat(Math.floor((fits - dir.length - 1) / 2)));
    expect(chinese.length).toBeLessThanOrEqual(fits);
    expect(Buffer.byteLength(chinese)).toBeGreaterThan(fits);
    expect(() => withLang('en', () => makeRunDirs(chinese, 'darwin'))).toThrow(/too long for the sockets/);
    expect(existsSync(chinese)).toBe(false);
  });

  it('keeps everything a stopped run left while something of it may still run, and gives no permission back', () => {
    const d = makeRunDirs(data);
    const locked = join(d.tmp, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const sweeps of [
      { byMarker: () => false, bySandbox: () => true }, // a holder of the marker survived
      { byMarker: () => true, bySandbox: () => false }, // the sweep by sandbox could not tell
    ]) {
      expect(clearRelaySandboxLeftovers(data, 'darwin', sweeps)).toBe(false);
      for (const p of [d.tmp, d.hostTmp, d.marker!]) expect(existsSync(p)).toBe(true);
      expect(statSync(locked).mode & 0o777).toBe(0o000);
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    // Once the sweeps find nothing left: all of it goes, the locked folder too.
    const seen: string[][] = [];
    expect(clearRelaySandboxLeftovers(data, 'darwin', { byMarker: (m) => (seen.push(m), true), bySandbox: (t) => (seen.push(t), true) })).toBe(true);
    expect(seen).toEqual([[d.marker], [d.tmp]]);
    for (const p of [d.tmp, d.hostTmp, d.marker!]) expect(existsSync(p)).toBe(false);
  });

  it('removes the folders and the marker together', () => {
    const d = makeRunDirs(data);
    removeRunDirs(d);
    for (const p of [d.tmp, d.hostTmp, d.marker!]) expect(existsSync(p)).toBe(false);
  });

  it('leaves no marker behind when the command cannot be made', async () => {
    const markers = () => (existsSync(relaySandboxRoot(data)) ? readdirSync(relaySandboxRoot(data)).filter((n) => n.endsWith('.marker')).length : 0);
    const before = markers();
    // Fails once the run's folders exist (an argument that is not a string breaks the command line).
    await expect(
      sandboxCommand('/bin/sh', [42 as unknown as string], { PATH: '/usr/bin:/bin' }, spec(), { ctx, available: async () => ({ ok: true }) }),
    ).rejects.toThrow();
    expect(markers()).toBe(before);
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('run folders', () => {
  it('makes fresh folders and a fresh marker in the data folder', () => {
    const d = makeRunDirs(data);
    expect(d.tmp.startsWith(relaySandboxRoot(data))).toBe(true);
    expect(d.hostTmp.startsWith(relaySandboxHostRoot(data))).toBe(true);
    // The marker sits beside the run's folder, not inside a sandbox-writable one, and is fresh.
    expect(d.marker!.startsWith(relaySandboxRoot(data))).toBe(true);
    expect(d.marker!.endsWith('.marker')).toBe(true);
    expect(existsSync(d.marker!)).toBe(true);
    removeRunDirs(d);
  });

  it('removes the marker when the run is disposed', async () => {
    const d = makeRunDirs(data);
    expect(existsSync(d.marker!)).toBe(true);
    const run = new RelaySandboxRun(d, {}, { localAddresses: [], platform: 'darwin', arch: 'arm64' });
    await run.dispose();
    expect(existsSync(d.marker!)).toBe(false);
    expect(existsSync(d.tmp)).toBe(false);
  });

  it('clears what runs left when the server stopped', () => {
    const d = makeRunDirs(data);
    writeFileSync(join(d.tmp, 'x'), 'x');
    clearRelaySandboxLeftovers(data);
    expect(existsSync(d.tmp)).toBe(false);
    expect(existsSync(relaySandboxRoot(data))).toBe(true);
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('leftoverSweepPids (startup sweep selection)', () => {
  const ps = ['100 1', '200 100', '201 100', '300 200', '400 1', '500 999'].join('\n');
  it('kills every holder and its descendants, excluding this server and init', () => {
    // 100 holds a leftover file; 200/201 are its children, 300 a grandchild; 400 holds one too.
    const pids = leftoverSweepPids('100\n400\n', ps, 999).sort((a, b) => a - b);
    expect(pids).toEqual([100, 200, 201, 300, 400]);
  });
  it('never includes the server itself, pid 1, blanks or non-numbers', () => {
    // 999 is this server (a child of a held pid in the table): it is still excluded.
    expect(leftoverSweepPids('1\n999\n\nnope\n100\n', ps, 999).sort((a, b) => a - b)).toEqual([100, 200, 201, 300]);
    expect(leftoverSweepPids('', ps, 999)).toEqual([]);
  });
  it('does not loop on a cycle in the table', () => {
    expect(leftoverSweepPids('10\n', '10 11\n11 10\n', 1).sort((a, b) => a - b)).toEqual([10, 11]);
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('the host', () => {
  it('runs with type stripping where Node does not do it by default', () => {
    expect(hostArgs({ typescript: false })).toEqual(['--experimental-strip-types', '--disable-warning=ExperimentalWarning', RELAY_SANDBOX_HOST]);
    expect(hostArgs({ typescript: 'strip' })).toEqual(['--disable-warning=ExperimentalWarning', RELAY_SANDBOX_HOST]);
  });

  it("gets none of the agent's environment and only the system's programs", () => {
    const env = hostEnv(ctx, '/h/tmp');
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env.TMPDIR).toBe('/h/tmp');
    expect(env.HOME).toBe(home);
    expect(Object.keys(env).filter((k) => /PROXY|NODE_OPTIONS|API_KEY/i.test(k))).toEqual([]);
    expect(hostEnv({ ...ctx, tools: { ...ctx.tools, rg: '/opt/homebrew/bin/rg' } }, '/h').PATH).toContain('/opt/homebrew/bin');
  });

  it('starts nothing without its control channel', async () => {
    const res = await runProcess({ bin: process.execPath, args: hostArgs(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 20_000 });
    expect(res.code).toBe(70);
    expect(res.stderr).toMatch(/no control channel/);
  });

  it('stops when the server closes the channel before sending the rules', async () => {
    const started = Date.now();
    const res = await runProcess({
      bin: process.execPath,
      args: hostArgs(),
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 20_000,
      channel: (end) => end.end(),
    });
    expect(res.code).toBe(71);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('fail closed', () => {
  it('refuses native Windows, other platforms, missing programs and processors without the seccomp helper', async () => {
    const win = await sandboxAvailable({ ...ctx, platform: 'win32' });
    expect(win.ok).toBe(false);
    await expect(withLang('en', () => sandboxAvailable({ ...ctx, platform: 'win32' }))).resolves.toEqual({ ok: false, reason: expect.stringMatching(/native Windows.*WSL2/) });
    expect(platformRefusal({ ...ctx, platform: 'freebsd' })).toEqual({ code: 'platform', detail: 'freebsd' });
    const missing = platformRefusal({ ...ctx, tools: { sh: '/bin/sh', bash: '/bin/bash', bwrap: '/usr/bin/bwrap' } });
    expect(missing).toEqual({ code: 'deps', detail: 'socat, ripgrep (rg) not installed' });
    // Said once, naming exactly what is missing and the packages to install for it.
    const en = withLang('en', () => failureText(missing!, 'linux'));
    expect(en).toMatch(/^Harness Relay's own sandbox needs socat, ripgrep \(rg\), which this computer does not have/);
    expect(en).toContain('sudo apt-get install socat ripgrep');
    expect(en).not.toContain('bubblewrap');
    expect(en).not.toContain('not installed');
    const zh = withLang('zh-TW', () => failureText(missing!, 'linux'));
    expect(zh).toContain('sudo apt-get install socat ripgrep');
    expect(zh).not.toMatch(/。。/);
    // On macOS a missing sandbox-exec gets macOS advice, never a Linux package manager.
    const mac = platformRefusal({ ...ctx, platform: 'darwin' });
    const macText = withLang('en', () => failureText(mac ?? { code: 'deps', detail: '/usr/bin/sandbox-exec not found' }, 'darwin'));
    expect(macText).not.toMatch(/apt-get|dnf/);
    expect(withLang('en', () => failureText({ code: 'deps', detail: '/usr/bin/sandbox-exec not found' }, 'darwin'))).toMatch(/sandbox-exec not found\. sandbox-exec is part of macOS/);
    // A detail that ends in a full stop gets no second one.
    expect(withLang('zh-TW', () => failureText({ code: 'probe', detail: '失敗了。' }, 'linux'))).not.toMatch(/。。/);
    expect(withLang('en', () => failureText({ code: 'probe', detail: 'it failed.' }, 'linux'))).not.toMatch(/\.\./);
    expect(platformRefusal({ ...ctx, arch: 'ia32' })).toEqual({ code: 'seccomp', detail: 'ia32' });
    expect(withLang('en', () => failureText({ code: 'seccomp', detail: '' }, 'linux', 'ia32'))).toMatch(/Unix sockets/);
    expect(withLang('en', () => failureText({ code: 'probe', detail: 'sandbox_apply: Operation not permitted' }, 'darwin'))).toMatch(/inside one/);
  });

  it("runs its host on the Node it was given (the desktop app's: one on PATH), and refuses without one", async () => {
    expect(hostNode({ tools: { sh: '/bin/sh', bash: '/bin/bash' } })).toBe(process.execPath);
    expect(hostNode({ tools: { sh: '/bin/sh', bash: '/bin/bash', node: '/opt/node/bin/node' } })).toBe('/opt/node/bin/node');
    for (const platform of ['linux', 'darwin'] as const) {
      const none = { ...ctx, platform, tools: { ...ctx.tools, node: null } };
      expect(platformRefusal(none)).toEqual({ code: 'node', detail: '' });
      await expect(withLang('en', () => sandboxAvailable(none))).resolves.toEqual({ ok: false, reason: expect.stringMatching(/Node\.js 22\.12 or later.*full access/) });
      await expect(withLang('zh-TW', () => sandboxAvailable(none))).resolves.toEqual({ ok: false, reason: expect.stringMatching(/Node\.js 22\.12.*完全存取/) });
    }
    // Native Windows is refused for itself, Node or not.
    expect(platformRefusal({ ...ctx, platform: 'win32', tools: { ...ctx.tools, node: null } })).toEqual({ code: 'windows', detail: '' });
  });

  it('does not make a command when the sandbox cannot start, or the spec leaves a hole', async () => {
    const ok = async () => ({ ok: true }) as const;
    await expect(sandboxCommand('/bin/sh', [], {}, spec(), { ctx, available: async () => ({ ok: false, reason: 'no sandbox here' }) })).rejects.toThrow('no sandbox here');
    await expect(sandboxCommand('/bin/sh', [], {}, spec({ allowedHosts: ['localhost:8787'] }), { ctx, available: ok })).rejects.toThrow(/Harness Relay/);
    await expect(sandboxCommand('/bin/sh', [], {}, spec({ protectedPaths: [join(home, 'a*')] }), { ctx, available: ok })).rejects.toThrow(/a\*/);
    await expect(sandboxCommand('no-such-agent-cli', [], { PATH: '/usr/bin' }, spec(), { ctx, available: ok })).rejects.toThrow(/no-such-agent-cli/);
    await expect(sandboxCommand('/bin/sh', [], {}, { ...spec(), permission: 'full' as never }, { ctx, available: ok })).rejects.toThrow();
    // Nothing was left behind by the refusals.
    clearRelaySandboxLeftovers(data);
  });

  it('gives a command for the host, its channel riding on its env', async () => {
    const s = await sandboxCommand('/bin/sh', ['-c', 'true'], { PATH: '/usr/bin:/bin', SECRET_KEY: 'k' }, spec(), { ctx, available: async () => ({ ok: true }) });
    expect(s.bin).toBe(process.execPath);
    expect(s.args).toEqual(hostArgs());
    expect(s.env.SECRET_KEY).toBeUndefined(); // the agent's env goes over the channel
    expect((s.env as Record<symbol, unknown>)[CONTROL_CHANNEL]).toBe(s.channel);
    expect(({ ...s.env } as Record<symbol, unknown>)[CONTROL_CHANNEL]).toBe(s.channel);
    expect(existsSync(s.run.dirs.tmp)).toBe(true);
    await s.dispose();
    expect(existsSync(s.run.dirs.tmp)).toBe(false);
  });
});

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('process.ts control channel', () => {
  it('gives a process fd 3 when its env carries a channel, and leaves the variable out', async () => {
    const got: string[] = [];
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    Object.defineProperty(env, CONTROL_CHANNEL, {
      enumerable: true,
      value: (end: Duplex) => end.on('data', (d: Buffer) => got.push(d.toString())),
    });
    const res = await runProcess({ bin: '/bin/sh', args: ['-c', 'echo hello >&3; env'], env: { ...env } });
    expect(res.code).toBe(0);
    expect(got.join('')).toBe('hello\n');
    expect(res.stdout).not.toMatch(/controlChannel/);
  });

  it('gives no fd 3 without one', async () => {
    const res = await runProcess({ bin: '/bin/sh', args: ['-c', 'echo x >&3'], env: { PATH: '/usr/bin:/bin' } });
    expect(res.code).not.toBe(0);
  });
});
