'use strict';
/*
 * Which CLI this process stands in for, and what it was started with. The entry (`fake-cli.cjs`)
 * finds the agent module for the name it runs under and hands it over (`use()`) before anything
 * else runs; the other modules ask here when they need to know, never while they load.
 */
const path = require('node:path');

const isSea = (() => {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
})();

/**
 * The name it runs under: its file's (`claude`, `cursor-agent.exe`, …), without `.exe`, `.cjs` or
 * `.js`, in lower case. Cursor's Windows launcher runs it as `node index.js` and tells the name it
 * was started by in CURSOR_INVOKED_AS (`cursor-agent.cmd`, `agent.cmd`): that name then, and only then.
 */
function runName() {
  const own = path
    .basename(isSea ? process.execPath : process.argv[1] || '')
    .replace(/\.(exe|cjs|js)$/i, '')
    .toLowerCase();
  const invoked = process.env.CURSOR_INVOKED_AS;
  return own === 'index' && invoked ? invoked.replace(/\.(cmd|bat)$/i, '').toLowerCase() : own;
}

const args = process.argv.slice(2);

let agent;
let agents = [];

/** This process is `one` (an agent module), among `all` (every agent module, in Harness Relay's order). */
function use(one, all) {
  agent = one;
  agents = all;
}

/** The agent module this process is. */
function me() {
  if (!agent) throw new Error('fake-cli: asked which CLI this is before the entry said so');
  return agent;
}

const has = (name) => args.includes(name);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

/** Variadic values of a flag (`--add-dir a b`), up to the next flag. */
function values(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let seq = 0;
const newId = (prefix) => `${prefix}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

module.exports = {
  isSea,
  runName,
  args,
  use,
  me,
  /** Its provider id (`claude`, `cursor`, `antigravity`, …): what the log, the directives and its errors name it. */
  cli: () => me().provider,
  /** Its name as Harness Relay shows it (`PROVIDER_LABEL`). */
  label: () => me().label,
  /** The CLI's own folder for this start, as the real one finds it: its sign-in, sessions and marks go there. */
  home: () => me().home(process.env, args),
  /** Every agent module, in Harness Relay's order of the CLIs. */
  agents: () => agents,
  has,
  flag,
  values,
  sleep,
  newId,
};
