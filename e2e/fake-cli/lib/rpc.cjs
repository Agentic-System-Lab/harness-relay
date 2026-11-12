'use strict';
/*
 * Line-delimited JSON on stdio, as every fake but the static commands speaks it: messages out, lines
 * in, the work under way that an end of stdin lets finish, and a JSON-RPC peer on top (Codex's
 * app-server leaves out the version field, ACP has it).
 */
const readline = require('node:readline');
const { exitAfterLog } = require('./log.cjs');
const self = require('./self.cjs');

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

/** Work under way (a turn), which an end of stdin lets finish, as the real CLIs do. */
const inFlight = new Set();
function track(promise) {
  const p = Promise.resolve(promise).catch((err) => {
    process.stderr.write(`fake ${self.cli()}: ${err && err.stack ? err.stack : err}\n`, () => exitAfterLog(1));
  });
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
  return p;
}

/** Calls `handle` with each JSON message on stdin; at its end, waits for the work under way and exits. */
function onLines(handle) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    track(handle(msg));
  });
  rl.on('close', async () => {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    process.stdout.write('', () => exitAfterLog(0));
  });
}

/**
 * A JSON-RPC peer on stdio (`versionField`: whether messages carry `"jsonrpc": "2.0"`). `onRequest`
 * answers the other side's requests (its result, or a thrown error); `onNotification` takes the rest.
 * `request()` asks the other side, `notify()` tells it.
 */
function rpcPeer(versionField, onRequest, onNotification) {
  const pending = new Map();
  let next = 1;
  const send = (msg) => out(versionField ? { jsonrpc: '2.0', ...msg } : msg);
  onLines(async (msg) => {
    if (typeof msg.method !== 'string') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id === undefined || msg.id === null) return onNotification(msg.method, msg.params || {});
    try {
      const result = await onRequest(msg.method, msg.params || {});
      send({ id: msg.id, result: result === undefined ? null : result });
    } catch (err) {
      const error = { code: err.code || -32603, message: err.message || String(err) };
      send({ id: msg.id, error: err.data === undefined ? error : { ...error, data: err.data } });
    }
  });
  return {
    notify: (method, params) => send({ method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = `fake-${next++}`;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      }),
  };
}

/** An error to answer a request with: its message, its code, and the `data` some CLIs give with it. */
const rpcError = (message, code = -32603, data) => Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });

/** Ends the CLI with an error, once its message is out (pipes are asynchronous on macOS and Windows). */
function fail(text) {
  process.stdout.write('', () => process.stderr.write(text + '\n', () => exitAfterLog(1)));
  return new Promise(() => {});
}

module.exports = { out, track, onLines, rpcPeer, rpcError, fail };
