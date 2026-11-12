'use strict';
/*
 * What the fake OpenCode and the fake Goose share: the other working directories a briefing names,
 * running a command through the CLI's shell, and reaching a URL as they do, through the proxy that
 * Harness Relay's own sandbox gives a run (HTTP_PROXY, which asks the user about a host no rule
 * decides), or directly without one.
 */
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

/** The working directories besides `cwd` a briefing names (Harness Relay's "use full paths for the others"; in parallel mode its worktrees). */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

/** Whether a command publishes outside this computer (`npm publish …`, `git push …`): never really run here. */
const publishes = (command) => /^(?:npm|pnpm|yarn) publish\b|^git push\b/.test(command);

/**
 * A command's output as the CLI runs it: `<shell> -c <command>` in the session's folder. Without a
 * shell (Windows), and for one that would publish (it would reach the network), what it would print.
 */
function runCommand(shell, command, cwd) {
  if (!shell || publishes(command)) {
    const m = /^(?:env )?echo (.*)$/.exec(command) || /^\S+ publish (.*)$/.exec(command);
    return { stdout: m ? `${m[1]}\n` : '', stderr: '', code: 0 };
  }
  const r = spawnSync(shell, ['-c', command], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : ''), code: typeof r.status === 'number' ? r.status : 1 };
}

/** How long a request may wait for its answer (the sandbox's proxy waits for the user's). */
const REACH_MS = 10 * 60_000;

/**
 * Tries to reach `url`, as the CLI's own HTTP client does: through the run's proxy (HTTP_PROXY, with
 * the credentials its URL holds; an HTTPS URL by a CONNECT tunnel), else directly. `{ status }` when
 * something answered, `{ refused: true }` when the sandbox's proxy refused the host (403, its mark), or
 * `{ error }` (the name did not resolve, the host is down…).
 */
function reach(url) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve({ error: 'not a URL' });
    }
    const https = target.protocol === 'https:';
    const proxyUrl = (https ? process.env.HTTPS_PROXY || process.env.https_proxy : undefined) || process.env.HTTP_PROXY || process.env.http_proxy;
    // An agent of its own: Node's own use of the proxy variables (NODE_USE_ENV_PROXY) is not wanted here.
    const agent = new http.Agent({ keepAlive: false });
    const done = (r) => {
      agent.destroy();
      resolve(r);
    };
    const port = target.port || (https ? '443' : '80');
    let req;
    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      const headers = proxy.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {};
      const via = { host: proxy.hostname, port: proxy.port || 80, agent };
      req = https
        ? http.request({ ...via, method: 'CONNECT', path: `${target.hostname}:${port}`, headers: { ...headers, host: `${target.hostname}:${port}` } })
        : http.request({ ...via, method: 'GET', path: url, headers: { ...headers, host: target.host } });
      req.on('connect', (res, socket) => {
        socket.destroy();
        done(res.statusCode === 200 ? { status: 200 } : { refused: res.statusCode === 403, status: res.statusCode });
      });
    } else if (https) {
      return resolve({ error: 'HTTPS without a proxy is not tried by the fake' });
    } else {
      req = http.request({ host: target.hostname, port, method: 'GET', path: `${target.pathname}${target.search}`, agent });
    }
    req.on('response', (res) => {
      res.resume();
      const refused = Boolean(proxyUrl) && res.statusCode === 403 && Object.keys(res.headers).some((h) => /proxy|deny|block/i.test(h));
      res.on('end', () => done(refused ? { refused: true, status: 403 } : { status: res.statusCode }));
      res.on('error', () => done({ status: res.statusCode }));
    });
    req.on('error', (err) => done({ error: err.code || err.message }));
    req.setTimeout(REACH_MS, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.end();
  });
}

/** What a reply says of a URL it tried (`reach()`'s answer). */
function reached(url, r) {
  if (r.refused) return `I may not reach ${url} here. `;
  if (r.error) return `I could not reach ${url} (${r.error}). `;
  return `I reached ${url} (HTTP ${r.status}). `;
}

module.exports = { briefedOthers, publishes, runCommand, reach, reached };
