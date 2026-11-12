'use strict';
/*
 * The fakes' log, for the tests to read (`relay.fakeLog()`): E2E_FAKE_LOG names a file that gets a
 * JSON line for each start, session and prompt. Inside Harness Relay's own sandbox (an open agent
 * below full access) that file is in none of the folders the run may write, so a line refused there
 * goes to the test's fake endpoint instead (E2E_FAKE_LOG_URL, `POST /e2e-log`): it is the run's model
 * backend, so a host the sandbox lets the run reach, and it appends the line to the same file, marked
 * `sandboxed: true`. Lines sent that way are awaited by every way out of the process (`exitAfterLog()`),
 * for two seconds at most.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const self = require('./self.cjs');

/** What a write gets where it may not write: the sandbox's refusal (EPERM on macOS, EROFS on Linux), or a folder's permissions. */
const REFUSED = new Set(['EPERM', 'EACCES', 'EROFS']);
const refused = (err) => Boolean(err && REFUSED.has(err.code));

/**
 * Writes `content` to `file`, making its folder first. False where it may not write there (as a
 * sandbox refuses), so the reply can say so; any other error is thrown.
 */
function tryWrite(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return true;
  } catch (err) {
    if (refused(err)) return false;
    throw err;
  }
}

/** Log lines on their way to the fake endpoint. */
const sending = new Set();

/** Appends `entry` to the log, with which CLI, process and time; over HTTP where the file may not be written. */
function record(entry) {
  const file = process.env.E2E_FAKE_LOG;
  if (!file) return;
  const line = { cli: self.cli(), pid: process.pid, at: Date.now(), ...entry };
  try {
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch (err) {
    // Anything else the log is not worth failing for: it is a convenience.
    if (refused(err)) send({ ...line, sandboxed: true });
  }
}

/** Sends a log line to the fake endpoint (nothing without one, or when it does not answer). */
function send(line) {
  const url = process.env.E2E_FAKE_LOG_URL;
  if (!url) return;
  const body = Buffer.from(JSON.stringify(line));
  const sent = new Promise((resolve) => {
    let req;
    try {
      req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length }, timeout: 2000 }, (res) => {
        res.on('error', resolve);
        res.on('end', resolve);
        res.resume();
      });
    } catch {
      return resolve();
    }
    req.on('error', resolve);
    req.on('timeout', () => req.destroy());
    req.end(body);
  });
  sending.add(sent);
  sent.then(() => sending.delete(sent));
}

/** Waits for the log lines still on their way, `maxMs` at most. */
function flushLog(maxMs = 2000) {
  if (!sending.size) return Promise.resolve();
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, maxMs)));
  return Promise.race([Promise.allSettled([...sending]), late]).then(() => clearTimeout(timer));
}

/** Ends the process with `code`, once its log lines are sent (at once when there are none). */
function exitAfterLog(code) {
  if (!sending.size) process.exit(code);
  void flushLog().then(() => process.exit(code));
}

module.exports = { record, tryWrite, refused, flushLog, exitAfterLog };
