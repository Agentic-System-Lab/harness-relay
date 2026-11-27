'use strict';
/*
 * A stand-in for Docker's CLI (`docker`) for the specs that remove Cua (`e2e/specs/computer.spec.ts`), so
 * that they never touch the Docker of the computer the tests run on. On Linux, Remove Cua's last step takes
 * Cua's helper container and images out of Docker once none of Cua's sandboxes is there
 * (`removeCuaRuntime()` in `src/server/computer/cua.ts`); with the real `docker` first on the PATH, a test
 * would delete the developer's own Cua images. `e2e/support/fake-cli.ts` builds it as `docker-fake/docker`
 * beside the fake CLIs (macOS and Linux only: Windows never runs that step), off the PATH; a spec that
 * wants it puts its folder first on its server's PATH (the `fakeDocker` option).
 *
 * Its Docker holds, until the test changes it, one helper container of Cua's (`cua-runsc-helper`), Cua's
 * desktop image pulled by digest, Cua's helper image, and an image that is not Cua's (`node:22`), kept as
 * a file in the Cua home (`$CUA_HOME/fake-docker.json`). It answers only what Remove Cua asks:
 * - `ps -a --filter label=ai.cua.managed=true --format …`: its containers, name and kind;
 * - `rm --force <name>`: removes one;
 * - `images --digests --format …`: its images, repository, tag and digest;
 * - `rmi <repo:tag | repo@digest>`: removes one;
 * anything else fails, saying it is not faked. Each start goes to the test's fake log (`cli: 'docker'`):
 * Harness Relay starts it with Cua's environment, never E2E_FAKE_LOG, so the log is found from the Cua home
 * (`<test>/home/.cua`), two folders up, as the fake cua finds it.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const HOME = process.env.CUA_HOME;
const LOG = process.env.E2E_FAKE_LOG || (HOME ? path.join(HOME, '..', '..', 'fake-cli.jsonl') : undefined);
const STATE = HOME ? path.join(HOME, 'fake-docker.json') : undefined;

function log(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ cli: 'docker', pid: process.pid, at: Date.now(), args, ...entry }) + '\n');
  } catch {
    /* the log is a convenience */
  }
}

const DIGEST = 'sha256:' + '3c'.repeat(32);
const FIRST = {
  containers: [{ name: 'cua-runsc-helper', kind: 'helper' }],
  images: [
    { repo: 'ghcr.io/trycua/linux', tag: '<none>', digest: DIGEST },
    { repo: 'cua-vmm/helper', tag: '1', digest: '<none>' },
    { repo: 'node', tag: '22', digest: 'sha256:' + '22'.repeat(32) },
  ],
};

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return structuredClone(FIRST);
  }
}

function save(state) {
  if (!STATE) return;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state));
}

function fail(message) {
  process.stderr.write(`Error response from daemon: ${message}\n`);
  process.exit(1);
}

function main() {
  log({});
  const state = load();
  const [cmd, ...rest] = args;
  if (cmd === 'ps' && rest.includes('-a') && rest.includes('label=ai.cua.managed=true')) {
    for (const c of state.containers) process.stdout.write(`${c.name}\t${c.kind}\n`);
    return;
  }
  if (cmd === 'rm' && rest[0] === '--force' && rest[1]) {
    const before = state.containers.length;
    state.containers = state.containers.filter((c) => c.name !== rest[1]);
    if (state.containers.length === before) return fail(`No such container: ${rest[1]}`);
    save(state);
    return process.stdout.write(`${rest[1]}\n`);
  }
  if (cmd === 'images' && rest.includes('--digests')) {
    for (const i of state.images) process.stdout.write(`${i.repo}\t${i.tag}\t${i.digest}\n`);
    return;
  }
  if (cmd === 'rmi' && rest.length === 1) {
    const ref = rest[0];
    const before = state.images.length;
    state.images = state.images.filter((i) => ref !== `${i.repo}:${i.tag}` && ref !== `${i.repo}@${i.digest}`);
    if (state.images.length === before) return fail(`No such image: ${ref}`);
    save(state);
    return process.stdout.write(`Untagged: ${ref}\n`);
  }
  fail(`fake docker: not faked: ${args.join(' ')}`);
}

main();
