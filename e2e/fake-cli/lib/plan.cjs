'use strict';
/*
 * What a fake says, whichever CLI it is: the lead agent's answers (a team, a group, a changed team),
 * and the steps of a turn's reply (`plan()`), shaped by the `e2e:` directives in the user's message,
 * which each CLI's module then plays in its own protocol.
 */
const fs = require('node:fs');
const { firstTime } = require('./home.cjs');
const { safeList } = require('./files.cjs');
const { record } = require('./log.cjs');
const self = require('./self.cjs');

/**
 * The directives a user message can hold. Each one is `e2e:<name>`, with `=<value>` for some, and
 * `@<cli>` to keep it to one CLI.
 */
const DIRECTIVES = {
  think: 'show some thinking first',
  tool: 'list the working directory with a tool first',
  todo: 'show a to-do list',
  approve: 'run a command that needs approval (`echo e2e-approval`; with `=publish`, `npm publish e2e-approval`, which asks in edit mode too), then say whether it ran',
  fetch: 'reach the URL given (a host the run may not reach without asking), then say whether it could',
  write: 'write the file named (relative to the working directory)',
  writeother: 'write the file named in the first other working directory the CLI was given (none: it says so)',
  ask: 'end the reply with a question for the user ([ASK_USER])',
  handoff: 'mention the member named, to hand the floor to it (not when that member is speaking)',
  slow: 'stream the reply slowly (about ten seconds), to be stopped',
  fail: 'exit with an error on stderr',
  error: "fail the turn inside the CLI's protocol (Claude's error result, a failed Codex turn, a JSON-RPC error over ACP)",
  flaky: 'fail the first time this message is answered, answer the next time (a retry)',
  markdown: 'answer with a heading, a list, a table and a code block',
  memory: "say the tool library's memory notes its briefing holds",
  skills: "read the SKILL.md of each tool library skill its briefing lists, and say its first line (or that it may not)",
};

function directivesIn(text) {
  const found = {};
  for (const m of text.matchAll(/\be2e:([a-z]+)(?:=([^\s@]+))?(?:@([a-z]+))?/gi)) {
    const [, name, value, only] = m;
    if (only && only.toLowerCase() !== self.cli()) continue;
    found[name.toLowerCase()] = value === undefined ? true : value;
  }
  return found;
}

const withoutDirectives = (text) => text.replace(/\be2e:\S+/gi, '').replace(/\s+/g, ' ').trim();

/** The last message the user wrote, in a turn prompt's chat (without the list of files it attached). */
function lastUserMessage(prompt) {
  let last;
  for (const m of prompt.matchAll(/<message from="user"[^>]*>\n([\s\S]*?)\n<\/message>/g)) last = m[1];
  return last === undefined ? undefined : last.replace(/\s*<attachments>[\s\S]*?<\/attachments>/g, '');
}

function tag(prompt, name) {
  const m = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt);
  return m ? m[1] : '';
}

/** The member name the fake lead agent gives a CLI's member (`Claude`, `OpenCode`): a valid @mention. */
function nameOf(provider) {
  const agent = self.agents().find((a) => a.provider === provider);
  return agent ? agent.name : provider[0].toUpperCase() + provider.slice(1);
}

/** The CLIs a list names (`claude,cursor`), by provider id; names that are none are left out. */
const providersIn = (list) =>
  String(list)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => self.agents().some((a) => a.provider === p));

/** The lead agent's answer: the team for a question (not JSON at all with `e2e:badplan`). */
function planReply(prompt) {
  const question = tag(prompt, 'question');
  const d = directivesIn(question);
  if (d.badplan) return 'I would rather not choose a team for this one.';
  if (typeof d.template === 'string') {
    return json({ choice: 'template', templateId: d.template, reason: 'The fake lead agent picked this template, as the question asked.' });
  }
  const providers = typeof d.team === 'string' ? providersIn(d.team) : [];
  const count = {};
  const agents = (providers.length ? providers : ['claude']).map((provider) => {
    count[provider] = (count[provider] || 0) + 1;
    const base = nameOf(provider);
    return { name: count[provider] > 1 ? `${base}${count[provider]}` : base, provider, role: `Answer the question as ${base}.` };
  });
  const mode = ['roundtable', 'parallel', 'relay'].includes(d.mode) ? d.mode : 'roundtable';
  return json({
    choice: 'custom',
    name: typeof d.name === 'string' ? d.name.replace(/_/g, ' ') : 'E2E team',
    description: 'A team picked by the fake lead agent.',
    mode,
    rounds: Number(d.rounds) || 1,
    maxHops: Number(d.hops) || 8,
    agents,
    reason: 'The fake lead agent picked the members the question asked for.',
  });
}

/** The lead agent's answer: the group a new conversation goes in (0: none). */
function groupReply(prompt) {
  const message = tag(prompt, 'message').toLowerCase();
  const groups = [...prompt.matchAll(/^(\d+)\. ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ n: Number(m[1]), name: JSON.parse(m[2]) }));
  const hit = groups.find((g) => message.includes(g.name.toLowerCase()));
  return JSON.stringify({ group: hit ? hit.n : 0 });
}

/** The lead agent's answer to "change the team": the team, with a member of each CLI `e2e:add` names. */
function reviseReply(prompt) {
  let team = {};
  try {
    team = JSON.parse(tag(prompt, 'team'));
  } catch {
    /* answered without it */
  }
  const agents = (team.agents || []).map((a) => ({ name: a.name, provider: a.provider }));
  const d = directivesIn(tag(prompt, 'request'));
  const added = typeof d.add === 'string' ? providersIn(d.add) : [];
  for (const provider of added) {
    let name = nameOf(provider);
    for (let n = 2; agents.some((a) => a.name.toLowerCase() === name.toLowerCase()); n++) name = `${nameOf(provider)}${n}`;
    agents.push({ name, provider, role: `Help the team as ${nameOf(provider)}.` });
  }
  return json({
    mode: team.mode || 'roundtable',
    rounds: team.rounds || 1,
    maxHops: team.maxHops || 8,
    agents,
    reason: added.length ? 'The fake lead agent added the members asked for.' : 'The fake lead agent kept the team as it is.',
  });
}

const json = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

/**
 * The steps of a reply: `think`, `text` (streamed in pieces), `tool` (a tool call and its result),
 * `todo`, `approve` (a command that needs approval), `write` (a file), `fetch` (a URL, `url`), `fail`
 * (exit) and `error` (a failure in the protocol). A CLI's module plays the steps it knows. `turn`: what the turn got besides its prompt (`cwd`, `images`, `mcp`,
 * `briefing`), and `mayRead(file)` where the CLI reads only some folders without asking (Claude Code).
 */
function plan(prompt, turn) {
  if (/Reply with only one of these JSON objects/.test(prompt)) return [{ type: 'text', text: planReply(prompt) }];
  if (/Reply with only this JSON object: \{"group"/.test(prompt)) return [{ type: 'text', text: groupReply(prompt) }];
  if (/Reply with only this JSON object, in a ```json code block, with the whole team/.test(prompt)) {
    return [{ type: 'text', text: reviseReply(prompt) }];
  }

  const me = (/your turn, @([^\s.,!?:;]+)/.exec(prompt) || [])[1] || self.label();
  const user = lastUserMessage(prompt);
  if (user === undefined) {
    // No new word from the user: a later round, or a teammate handed over.
    if (/Reply with \[PASS\] if you have nothing new to add/.test(prompt)) return [{ type: 'text', text: '[PASS]' }];
    return [{ type: 'text', text: `${me} (${self.label()}) here, following on from my teammate.` }];
  }
  const d = directivesIn(user);
  const said = withoutDirectives(user);
  const steps = [];
  if (d.fail) return [{ type: 'fail', text: `fake ${self.cli()}: failing as asked (e2e:fail)` }];
  if (d.error) return [{ type: 'error', text: `fake ${self.cli()}: the model returned an error (e2e:error)` }];
  if (d.flaky && firstTime(user)) return [{ type: 'fail', text: `fake ${self.cli()}: failing this once (e2e:flaky)` }];
  if (d.think) steps.push({ type: 'think', text: `${me} is thinking about “${said}”.` });
  if (d.todo) {
    steps.push({
      type: 'todo',
      entries: [
        { text: 'Read the question', status: 'completed' },
        { text: 'Write the answer', status: 'in_progress' },
        { text: 'Check it', status: 'pending' },
      ],
    });
  }
  if (d.tool) steps.push({ type: 'tool', kind: 'list', output: safeList(turn.cwd) });
  if (d.approve) steps.push({ type: 'approve', command: d.approve === 'publish' ? 'npm publish e2e-approval' : 'echo e2e-approval' });
  if (typeof d.fetch === 'string') steps.push({ type: 'fetch', url: d.fetch });
  const content = `Written by ${me} (${self.label()}).\n`;
  if (typeof d.write === 'string') steps.push({ type: 'write', path: d.write, content });
  if (typeof d.writeother === 'string') steps.push({ type: 'write', path: d.writeother, other: true, content });
  const answered = /You asked the user a question and their reply is among the messages above/.test(prompt);
  let text = answered ? `Thanks, ${me} got your answer: “${said}”.` : `Hello from ${me} (${self.label()}). You said: “${said}”.`;
  if (turn.images) text += ` I got ${turn.images} image${turn.images === 1 ? '' : 's'}.`;
  if (turn.mcp && turn.mcp.length) text += ` My tool library's MCP servers: ${turn.mcp.join(', ')}.`;
  if (d.memory) text += memoryIn(turn.briefing) ? ` My memory: “${memoryIn(turn.briefing)}”.` : ' I have no memory notes.';
  if (d.skills) text += readSkills(turn);
  if (d.markdown) {
    text += '\n\n## Fake findings\n\n- first point\n- second point\n\n| CLI | Fake |\n| --- | --- |\n| ' + self.label() + ' | yes |\n\n```js\nconst answer = 42;\n```';
  }
  if (typeof d.handoff === 'string' && d.handoff.toLowerCase() !== me.toLowerCase()) text += ` @${d.handoff}, over to you.`;
  if (d.ask) text += '\n\nWhich option do you prefer, A or B? [ASK_USER]';
  steps.push({ type: 'text', text, slow: Boolean(d.slow) });
  return steps;
}

/** The tool library's memory a briefing holds (its `<memory>` block), on one line; '' when none. */
function memoryIn(briefing) {
  const m = /<memory>\n([\s\S]*?)\n<\/memory>/.exec(briefing || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** The tool library's skills a briefing lists (`- name: description (…/SKILL.md)` under `# Skills`). */
function skillsIn(briefing) {
  const section = /# Skills\n.*\n((?:- .*(?:\n|$))+)/.exec(briefing || '');
  if (!section) return [];
  return section[1].split('\n').flatMap((line) => {
    const m = /^- (.+?)(?:: .*)? \((.+SKILL\.md)\)$/.exec(line);
    return m ? [{ name: m[1], file: m[2] }] : [];
  });
}

/** Reads each skill's SKILL.md, as an agent does when a task matches: its first line after the front matter. */
function readSkills(turn) {
  const skills = skillsIn(turn.briefing);
  if (!skills.length) return ' I was given no skills.';
  return skills
    .map((s) => {
      if (turn.mayRead && !turn.mayRead(s.file)) return ` I may not read the skill ${s.name}.`;
      try {
        const body = fs.readFileSync(s.file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
        const first = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
        return ` I read the skill ${s.name}: “${first}”.`;
      } catch (err) {
        return ` I could not read the skill ${s.name} (${err.code || err.message}).`;
      }
    })
    .join('');
}

/**
 * Records the values the tool library's MCP servers were given (by server: env, or an HTTP server's
 * headers), and `http`: the URL of each one given as an HTTP server, by server.
 */
function recordMcpEnv(servers, http = {}) {
  if (Object.keys(servers).length) record({ mcpEnv: servers, ...(Object.keys(http).length ? { mcpHttp: http } : {}) });
}

/** Pieces of `text` to stream: a few words each, or many small ones for a slow reply. */
function pieces(text, slow) {
  if (slow) {
    const out = [];
    for (let i = 0; i < 40; i++) out.push(i === 0 ? text : ' …');
    return out;
  }
  const words = text.split(/(?<=\s)/);
  const out = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
  return out.length ? out : [text];
}
const pieceDelay = (slow) => (slow ? 250 : 15);

/** The note the user gave with a decline, as Harness Relay passes it on ("Their message: …"). */
function noteIn(message) {
  const m = /Their message: (.*?)(?: Do not retry|$)/s.exec(String(message || ''));
  return m ? m[1].trim() : '';
}
const declined = (what, note) => `The ${what} was declined${note ? ` (the user said: ${note})` : ''}. `;
const noOther = (step) => `I was given no other working directory for ${step.path}. `;
const wrote = (step, ok, note) => (ok ? `I wrote ${step.path}. ` : `I may not write ${step.path} here${note ? ` (the user said: ${note})` : ''}. `);

module.exports = {
  DIRECTIVES,
  directivesIn,
  withoutDirectives,
  lastUserMessage,
  tag,
  nameOf,
  providersIn,
  plan,
  memoryIn,
  skillsIn,
  readSkills,
  recordMcpEnv,
  pieces,
  pieceDelay,
  noteIn,
  declined,
  noOther,
  wrote,
};
