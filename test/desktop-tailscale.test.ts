import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findTailscale, freeHttpsPort, parseStatus, servedUrl, shareOutcome, sharePlan, Tailscale, tailscaleLink } from '../desktop/src/tailscale';

const dir = mkdtempSync(join(tmpdir(), 'relay-tailscale-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posixIt = process.platform === 'win32' ? it.skip : it;

describe('finding tailscale', () => {
  it('looks on PATH first', () => {
    const exists = (p: string) => p === '/opt/bin/tailscale' || p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    expect(findTailscale({ PATH: '/usr/bin:/opt/bin' }, 'darwin', exists)).toBe('/opt/bin/tailscale');
  });

  it("uses the Mac app's own binary when the command is not installed", () => {
    const exists = (p: string) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    expect(findTailscale({ PATH: '/usr/bin' }, 'darwin', exists)).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });

  it('finds tailscale.exe on Windows, on PATH or in Program Files', () => {
    expect(findTailscale({ PATH: 'C:\\Windows;C:\\Tools\\' }, 'win32', (p) => p === 'C:\\Tools\\tailscale.exe')).toBe('C:\\Tools\\tailscale.exe');
    expect(findTailscale({ PATH: 'C:\\Windows', ProgramFiles: 'D:\\Programs' }, 'win32', (p) => p === 'D:\\Programs\\Tailscale\\tailscale.exe')).toBe(
      'D:\\Programs\\Tailscale\\tailscale.exe',
    );
  });

  it('is undefined when there is none', () => {
    expect(findTailscale({ PATH: '/usr/bin' }, 'linux', () => false)).toBeUndefined();
  });
});

describe('tailscale status', () => {
  it("reads whether it runs and this computer's name, without the final dot", () => {
    const json = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'My-Mac.tail1234.ts.net.' } });
    expect(parseStatus(json)).toEqual({ running: true, dnsName: 'my-mac.tail1234.ts.net' });
  });

  it('is not running when signed out, or on output that is not JSON', () => {
    expect(parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }))).toEqual({ running: false, dnsName: undefined });
    expect(parseStatus('failed to connect to local tailscaled')).toEqual({ running: false });
  });
});

describe('the shared address', () => {
  const config = (hostPort: string, proxy: string) => JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [hostPort]: { Handlers: { '/': { Proxy: proxy } } } } });

  it('is the HTTPS name when the port is shared on 443', () => {
    expect(servedUrl(config('my-mac.tail1234.ts.net:443', 'http://127.0.0.1:8787'), 8787)).toBe('https://my-mac.tail1234.ts.net');
  });

  it('keeps another HTTPS port, and accepts localhost as the target', () => {
    expect(servedUrl(config('my-mac.tail1234.ts.net:8443', 'http://localhost:8787'), 8787)).toBe('https://my-mac.tail1234.ts.net:8443');
  });

  it('is undefined when another port, or nothing, is shared', () => {
    expect(servedUrl(config('my-mac.tail1234.ts.net:443', 'http://127.0.0.1:9999'), 8787)).toBeUndefined();
    expect(servedUrl('{}', 8787)).toBeUndefined();
    expect(servedUrl('not json', 8787)).toBeUndefined();
  });
});

describe('sharing with the tailnet', () => {
  const run = (o: Partial<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>) =>
    shareOutcome({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });

  it('reads the address from a successful run', () => {
    const stdout = 'Available within your tailnet:\n\nhttps://my-mac.tail1234.ts.net/\n|-- / proxy http://127.0.0.1:8787\n';
    expect(run({ stdout })).toEqual({ kind: 'shared', url: 'https://my-mac.tail1234.ts.net' });
  });

  it("opens Tailscale's page when Serve has to be turned on first", () => {
    const stdout = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n';
    expect(run({ code: null, timedOut: true, stdout })).toEqual({ kind: 'needs-approval', link: 'https://login.tailscale.com/f/serve?node=abc123' });
  });

  it('opens only pages of Tailscale', () => {
    expect(tailscaleLink('visit https://evil.example/login.tailscale.com now')).toBeUndefined();
    expect(tailscaleLink('see https://tailscale.com/kb/1312/serve')).toBe('https://tailscale.com/kb/1312/serve');
  });

  it('tells a Linux user without the right to change settings what to run', () => {
    expect(run({ code: 1, stderr: 'Access denied: serve config denied' }).kind).toBe('access-denied');
  });

  it('passes any other failure on', () => {
    expect(run({ code: 1, stderr: 'boom' })).toEqual({ kind: 'failed', output: 'boom' });
    expect(run({ code: null, timedOut: true })).toEqual({ kind: 'failed', output: 'timed out' });
  });
});

describe('where to share without taking over what is shared', () => {
  const web = (entries: Record<string, string>) =>
    JSON.stringify({ Web: Object.fromEntries(Object.entries(entries).map(([hostPort, proxy]) => [hostPort, { Handlers: { '/': { Proxy: proxy } } }])) });

  it('shares nothing when what is shared cannot be read, since it could take over a port or Funnel', () => {
    // The command failed or timed out…
    expect(sharePlan(undefined, 8787)).toEqual({ kind: 'unknown' });
    // …or printed something that is not its JSON.
    expect(sharePlan('Error: connection refused', 8787)).toEqual({ kind: 'unknown' });
    expect(sharePlan('{"Web": ', 8787)).toEqual({ kind: 'unknown' });
  });

  it('shares on the first free HTTPS port, or says where it is shared already', () => {
    expect(sharePlan('', 8787)).toEqual({ kind: 'share', https: 443 });
    expect(sharePlan('{}', 8787)).toEqual({ kind: 'share', https: 443 });
    expect(sharePlan('null', 8787)).toEqual({ kind: 'share', https: 443 });
    expect(sharePlan(web({ 'my-mac.ts.net:443': 'http://127.0.0.1:3000' }), 8787)).toEqual({ kind: 'share', https: 8443 });
    expect(sharePlan(web({ 'my-mac.ts.net:8443': 'http://127.0.0.1:8787' }), 8787)).toEqual({ kind: 'shared', url: 'https://my-mac.ts.net:8443' });
    const full = web({ 'a.ts.net:443': 'http://127.0.0.1:1', 'a.ts.net:8443': 'http://127.0.0.1:2', 'a.ts.net:10000': 'http://127.0.0.1:3' });
    expect(sharePlan(full, 8787)).toEqual({ kind: 'ports-taken' });
  });

  it('is 443 when nothing is shared, or when it already shares this port', () => {
    expect(freeHttpsPort('{}', 8787)).toBe(443);
    expect(freeHttpsPort('', 8787)).toBe(443);
    expect(freeHttpsPort(web({ 'my-mac.ts.net:443': 'http://127.0.0.1:8787' }), 8787)).toBe(443);
  });

  it('moves to 8443, then 10000, when another service has 443', () => {
    expect(freeHttpsPort(web({ 'my-mac.ts.net:443': 'http://127.0.0.1:3000' }), 8787)).toBe(8443);
    expect(freeHttpsPort(web({ 'my-mac.ts.net:443': 'http://127.0.0.1:3000', 'my-mac.ts.net:8443': 'http://127.0.0.1:9999' }), 8787)).toBe(10000);
  });

  it('counts a port forwarded as plain TCP, or a / that serves files or text, as taken', () => {
    expect(freeHttpsPort(JSON.stringify({ TCP: { '443': { TCPForward: '127.0.0.1:22' } } }), 8787)).toBe(8443);
    const files = JSON.stringify({ Web: { 'my-mac.ts.net:443': { Handlers: { '/': { Path: '/srv/www' } } } } });
    expect(freeHttpsPort(files, 8787)).toBe(8443);
  });

  it('never takes a port published to the internet (Funnel), which sharing it for the tailnet would turn off', () => {
    const funnel = JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: { 'my-mac.ts.net:443': { Handlers: { '/webhook': { Proxy: 'http://127.0.0.1:3000' } } } },
      AllowFunnel: { 'my-mac.ts.net:443': true },
    });
    expect(freeHttpsPort(funnel, 8787)).toBe(8443);
    expect(freeHttpsPort(JSON.stringify({ AllowFunnel: { 'my-mac.ts.net:443': false } }), 8787)).toBe(443);
  });

  it('leaves a port alone when only another path is shared there', () => {
    const other = JSON.stringify({ Web: { 'my-mac.ts.net:443': { Handlers: { '/grafana': { Proxy: 'http://127.0.0.1:3000' } } } } });
    expect(freeHttpsPort(other, 8787)).toBe(443);
  });

  it('is undefined when every usual port is taken', () => {
    expect(freeHttpsPort(web({ 'a.ts.net:443': 'http://127.0.0.1:1', 'a.ts.net:8443': 'http://127.0.0.1:2', 'a.ts.net:10000': 'http://127.0.0.1:3' }), 8787)).toBeUndefined();
  });
});

describe('the tailscale command', () => {
  /** A fake tailscale: records its arguments, answers as a real one would. */
  function fake(script: string): { bin: string; calls: () => string[] } {
    const bin = join(dir, `tailscale-${Math.random().toString(36).slice(2)}`);
    const log = `${bin}.calls`;
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\n${script}\n`);
    chmodSync(bin, 0o755);
    return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
  }
  const env = { PATH: '/usr/bin:/bin' };

  posixIt('reads the status and the shared address', async () => {
    const t = fake(`case "$1 $2" in
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"My-Mac.tail1.ts.net."}}' ;;
  "serve status") echo '{"Web":{"my-mac.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}' ;;
esac`);
    const ts = new Tailscale(t.bin, env);
    expect(await ts.status()).toEqual({ running: true, dnsName: 'my-mac.tail1.ts.net' });
    expect(await ts.servedUrl(8787)).toBe('https://my-mac.tail1.ts.net');
    expect(await ts.servedUrl(9999)).toBeUndefined();
    expect(t.calls()).toEqual(['status --json', 'serve status --json', 'serve status --json']);
  });

  posixIt('shares on 443 without a flag, and on another HTTPS port with one', async () => {
    const t = fake(`echo "Available within your tailnet:"; echo; echo "https://my-mac.tail1.ts.net\${PORTSUFFIX}/"`);
    const ts = new Tailscale(t.bin, env);
    expect(await ts.share(8787)).toEqual({ kind: 'shared', url: 'https://my-mac.tail1.ts.net' });
    expect(await ts.share(8787, 8443)).toMatchObject({ kind: 'shared' });
    expect(t.calls()).toEqual(['serve --bg 8787', 'serve --bg --https=8443 8787']);
  });

  posixIt("stops a share that waits for Serve to be turned on, and gives Tailscale's page", async () => {
    const t = fake(`echo "Serve is not enabled on your tailnet."; echo "To enable, visit:"; echo "  https://login.tailscale.com/f/serve?node=abc"; sleep 30`);
    const started = Date.now();
    // Enough time for the link to be printed on a busy machine, far less than the 30 s it waits.
    const result = await new Tailscale(t.bin, env, { share: 3000 }).share(8787);
    expect(result).toEqual({ kind: 'needs-approval', link: 'https://login.tailscale.com/f/serve?node=abc' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  posixIt('is not running when the command fails or is missing', async () => {
    const t = fake('echo "failed to connect to local tailscaled" >&2; exit 1');
    expect(await new Tailscale(t.bin, env).status()).toEqual({ running: false });
    expect(await new Tailscale(t.bin, env).servedUrl(8787)).toBeUndefined();
    expect(await new Tailscale(join(dir, 'missing'), env).status()).toEqual({ running: false });
    expect(await new Tailscale(join(dir, 'missing'), env).share(8787)).toMatchObject({ kind: 'failed' });
  });
});
