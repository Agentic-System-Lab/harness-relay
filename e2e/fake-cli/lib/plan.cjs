'use strict';
/*
 * What a fake says, whichever CLI it is: the lead agent's answers (a team, a group, a changed team, a
 * review of the team's replies),
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
  approve:
    'run a command that needs approval (`echo e2e-approval`; with `=publish`, `npm publish e2e-approval`, which asks in edit mode too), then say whether it ran',
  flag: 'as the lead agent reviewing a request ("Approve for me"), find it potentially unsafe instead of approving it',
  slowapprove: 'as the lead agent reviewing a request ("Approve for me"), take `=<seconds>` (ten by default) to answer',
  fetch: 'reach the URL given (a host the run may not reach without asking), then say whether it could',
  write: 'write the file named (relative to the working directory)',
  writeother: 'write the file named in the first other working directory the CLI was given (none: it says so)',
  ask: 'end the reply with a question for the user ([ASK_USER])',
  steps:
    'end the reply with a <steps> block of three steps for the user to take outside Harness Relay, the first with a link (a steps card)',
  handoff: 'mention the member named, to hand the floor to it (not when that member is speaking)',
  slow: 'stream the reply slowly, about ten seconds (`=<seconds>` for another time), to be stopped or waited for; a reply of several paragraphs (`e2e:long`) one paragraph after another',
  fail: 'exit with an error on stderr',
  error: "fail the turn inside the CLI's protocol (Claude's error result, a failed Codex turn, a JSON-RPC error over ACP)",
  flaky: 'fail the first time this message is answered, answer the next time (a retry)',
  long: 'answer with forty short paragraphs, before what `e2e:markdown` writes (a reply taller than the window)',
  markdown: 'answer with a heading, a list, a table and a code block',
  mermaid: 'answer with a Mermaid diagram (a ```mermaid code block)',
  widecode: 'answer with a code block of one line far wider than a phone, which scrolls sideways',
  memory: "say the tool library's memory notes its briefing holds",
  remember:
    'end the reply with a <remember> block saving what the user said (without the directives) as a long-term memory note for every conversation',
  recall: 'say the long-term memory notes its turn was given: the pinned ones its briefing loads and those its prompt recalls',
  secret: 'end the reply with a <secret> block asking the user for the secret named (`E2E_TOKEN` by default)',
  command:
    'end the reply with a <command> block proposing the fixed command named (`e2e-check` by default), which prints its secrets file (whose values Harness Relay masks) and the input it read, and gets `E2E_TOKEN`',
  commandrun:
    'end the reply with a <command-run> block putting one run of the fixed command named (`e2e-check` by default) in the outbox, with a line of input',
  skills: 'read the SKILL.md of each tool library skill its briefing lists, and say its first line (or that it may not)',
  progress:
    'end the reply with a <progress> block of the status given (`working` by default) about the goal its briefing says a schedule tracks',
  interactive:
    'end the reply with an <interactive> block: a command for the user to run from its card, which prints a link and a code, asks for a password and prints what it read (`=askpass`: one that asks through the password helper, as `sudo -A` does)',
  mcpserver: 'choose the server for an e2e:mcp call; defaults to the Relay gateway',
  mcp: "call the tool named on Harness Relay's own MCP server (`relay`), with the JSON object in the message as its arguments, and say what it answered (Claude Code's fake only)",
  subagent:
    "hand the look around to a subagent (Explore, on haiku) that lists the working directory and reads its README, the reading taking `=<seconds>` (one by default), and then a subagent of its own that searches; then report that the CLI compacted its context (Claude Code's fake only)",
  steer:
    'wait in the turn, about ten seconds (`=<seconds>` for another time), for a message sent into it (steering), then answer, saying what it heard (Claude Code’s and Codex’s fakes; the others answer at once)',
};

/**
 * The commands `e2e:interactive` asks the user to run (shell, run by Harness Relay from the card): a
 * device sign-in that reads a password from its input and prints it (masked on the card), or one that
 * asks through the password helper (`$SUDO_ASKPASS`, as `sudo -A` runs it).
 */
const INTERACTIVE = {
  device:
    '<interactive reason="To sign in to the example service.">printf \'Open https://example.test/device and enter ABCD-1234\\nPassword: \'; IFS= read -r p; printf \'Got %s\\n\' "$p"</interactive>',
  askpass:
    '<interactive reason="To unlock the e2e key.">p=$("$SUDO_ASKPASS" \'Passphrase for the e2e key:\'); echo "helper got $p"</interactive>',
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

const withoutDirectives = (text) =>
  text
    .replace(/\be2e:\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

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

/**
 * The lead agent's answer: the team for a question (not JSON at all with `e2e:badplan`), and slow (about
 * ten seconds, to be stopped or watched while it designs; `=<seconds>` for another time) with `e2e:slowplan`.
 */
function planReply(prompt) {
  const d = directivesIn(tag(prompt, 'question'));
  return { text: planText(d), slow: slowMs(d.slowplan) };
}

function planText(d) {
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

/**
 * The lead agent's answer to an approval request it reviews ("Approve for me"): approved, unless the
 * user's latest message says `e2e:flag`; slow with `e2e:slowapprove` (ten seconds, `=<seconds>` for another time).
 */
function approvalReply(prompt) {
  const said = [...prompt.matchAll(/<user_message>\n([\s\S]*?)\n<\/user_message>/g)].map((m) => m[1]);
  const d = directivesIn(said[said.length - 1] || '');
  const text = JSON.stringify(
    d.flag
      ? { decision: 'ask', reason: 'The fake lead agent was told to flag it.' }
      : { decision: 'approve', reason: 'The fake lead agent finds it safe.' },
  );
  return { text, slow: slowMs(d.slowapprove) };
}

/** The lead agent's answer: the group a new conversation goes in (0: none). */
function groupReply(prompt) {
  const message = tag(prompt, 'message').toLowerCase();
  const groups = [...prompt.matchAll(/^(\d+)\. ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ n: Number(m[1]), name: JSON.parse(m[2]) }));
  const hit = groups.find((g) => message.includes(g.name.toLowerCase()));
  return JSON.stringify({ group: hit ? hit.n : 0 });
}

/**
 * The lead agent's answer to "change the team": the team, with a member of each CLI `e2e:add` names;
 * slow with `e2e:slowrevise` (about ten seconds, `=<seconds>` for another time), read from the request.
 */
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

/**
 * The lead agent's review of the team's replies: one highlight quoting the first words of the first
 * reply (`e2e:reviewquote=list` for the words of the list `e2e:markdown` writes, across its two items;
 * `e2e:reviewquote=none` for none: the point is about the reply, with no words of it;
 * `e2e:reviewkind=<kind>` for its kind, a risk by default), a step for the user and one for the
 * team, which asks the first reply's member to go on. Not JSON at all with `e2e:badreview`, and slow
 * (about ten seconds, to be stopped) with `e2e:slowreview`; both read from the user's messages it got.
 */
function reviewReply(prompt) {
  const recent = tag(prompt, 'recent');
  const users = [...recent.matchAll(/<message from="user">\n([\s\S]*?)\n<\/message>/g)].map((m) => m[1]);
  const d = directivesIn(users.join('\n'));
  if (d.badreview) return { text: 'The replies look fine to me.' };
  const replies = [...recent.matchAll(/<reply n="(\d+)" from="@([^\s"]+)[^>]*>\n([\s\S]*?)\n<\/reply>/g)].map((m) => ({
    n: Number(m[1]),
    name: m[2],
    text: m[3],
  }));
  const first = replies[0];
  // `e2e:reviewquote=list`: words across the two items of the list `e2e:markdown` writes; `none`: no words.
  const words =
    d.reviewquote === 'none'
      ? ''
      : d.reviewquote === 'list'
        ? 'first point second point'
        : first
          ? first.text.split(/\s+/).slice(0, 4).join(' ')
          : '';
  const kind = typeof d.reviewkind === 'string' ? d.reviewkind : 'risk';
  return {
    text: json({
      summary: `The fake lead agent read ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}.`,
      highlights: first
        ? [{ kind, reply: first.n, ...(words ? { quote: words } : {}), note: `The fake lead agent flags what @${first.name} said first.` }]
        : [],
      nextSteps: [
        { text: 'Try the answer yourself.', by: 'user' },
        ...(first
          ? [{ text: `Ask @${first.name} to go on.`, by: 'team', message: `@${first.name} please go on with the next part.` }]
          : []),
      ],
    }),
    slow: d.slowreview ? slowMs(true) : 0,
  };
}

const json = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

/**
 * The steps of a reply: `think`, `text` (streamed in pieces), `tool` (a tool call and its result),
 * `todo`, `approve` (a command that needs approval), `write` (a file), `fetch` (a URL, `url`), `fail`
 * (exit) and `error` (a failure in the protocol). A CLI's module plays the steps it knows. `turn`: what the turn got besides its prompt (`cwd`, `images`, `mcp`,
 * `briefing`), and `mayRead(file)` where the CLI reads only some folders without asking (Claude Code).
 */
const MODEL_CHECK_PROMPT = 'Reply with exactly RELAY_MODEL_OK.';

function plan(prompt, turn) {
  if (prompt.includes(MODEL_CHECK_PROMPT)) {
    const fails = process.env.E2E_FAIL_MODEL_CHECK_CLIS?.split(',').includes(self.cli());
    return [{ type: 'text', text: fails ? 'Model unavailable' : 'RELAY_MODEL_OK' }];
  }
  if (/Reply with only one of these JSON objects/.test(prompt)) return [{ type: 'text', ...planReply(prompt) }];
  if (/Reply with only this JSON object: \{"group"/.test(prompt)) return [{ type: 'text', text: groupReply(prompt) }];
  if (/Reply with only this JSON object:\n\{"changes"/.test(prompt)) return [{ type: 'text', text: tidyReply(prompt) }];
  if (/Reply with only this JSON object: \{"decision": "approve" \| "ask"/.test(prompt))
    return [{ type: 'text', ...approvalReply(prompt) }];
  if (/Reply with only this JSON object, in a ```json code block, with the whole team/.test(prompt)) {
    const d = directivesIn(tag(prompt, 'request'));
    return [{ type: 'text', text: reviseReply(prompt), slow: slowMs(d.slowrevise) }];
  }
  if (/Reply with only this JSON object, in a ```json code block, with your review/.test(prompt)) {
    const { text, slow } = reviewReply(prompt);
    return [{ type: 'text', text, slow }];
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
  if (d.subagent) steps.push({ type: 'subagent', output: safeList(turn.cwd), wait: slowMs(d.subagent === true ? 1 : d.subagent) });
  if (d.approve) steps.push({ type: 'approve', command: d.approve === 'publish' ? 'npm publish e2e-approval' : 'echo e2e-approval' });
  if (typeof d.fetch === 'string') steps.push({ type: 'fetch', url: d.fetch });
  if (typeof d.mcp === 'string') {
    const json = /\{[\s\S]*\}/.exec(user);
    let args = {};
    try {
      args = json ? JSON.parse(json[0]) : {};
    } catch {
      /* no arguments */
    }
    steps.push({ type: 'mcp', server: typeof d.mcpserver === 'string' ? d.mcpserver : 'relay', tool: d.mcp, args });
  }
  const content = `Written by ${me} (${self.label()}).\n`;
  if (typeof d.write === 'string') steps.push({ type: 'write', path: d.write, content });
  if (typeof d.writeother === 'string') steps.push({ type: 'write', path: d.writeother, other: true, content });
  const answered = /You asked the user a question and their reply is among the messages above/.test(prompt);
  let text = answered ? `Thanks, ${me} got your answer: “${said}”.` : `Hello from ${me} (${self.label()}). You said: “${said}”.`;
  if (turn.images) text += ` I got ${turn.images} image${turn.images === 1 ? '' : 's'}.`;
  if (turn.mcp && turn.mcp.length) text += ` My tool library's MCP servers: ${turn.mcp.join(', ')}.`;
  if (d.memory) text += memoryIn(turn.briefing) ? ` My memory: “${memoryIn(turn.briefing)}”.` : ' I have no memory notes.';
  if (d.recall) {
    // Cursor's briefing comes at the top of its prompt.
    const notes = longTermIn(`${turn.briefing || ''}\n${prompt}`);
    text += notes.length ? ` My long-term memory: ${notes.map((n) => `“${n}”`).join(', ')}.` : ' I have no long-term memory notes.';
  }
  if (d.skills) text += readSkills(turn);
  if (d.long) text += Array.from({ length: 40 }, (_, i) => `\n\nPadding paragraph ${i + 1} of a long reply.`).join('');
  if (d.markdown) {
    text +=
      '\n\n## Fake findings\n\n- first point\n- second point\n\n| CLI | Fake |\n| --- | --- |\n| ' +
      self.label() +
      ' | yes |\n\n```js\nconst answer = 42;\n```';
  }
  if (d.mermaid) text += '\n\n```mermaid\ngraph TD\n  Question --> Answer\n```';
  if (d.widecode) text += `\n\n\`\`\`js\nconst wide = '${'wide '.repeat(80).trim()}';\n\`\`\``;
  if (typeof d.handoff === 'string' && d.handoff.toLowerCase() !== me.toLowerCase()) text += ` @${d.handoff}, over to you.`;
  if (d.ask) text += '\n\nWhich option do you prefer, A or B? [ASK_USER]';
  if (d.steps) {
    text +=
      '\n\nPlease set up the app, then come back.\n\n<steps>\n1. Open [the example console](https://example.com/console) and create an app.\n' +
      '2. Copy the app ID.\n3. Turn on the API under **Use cases**.\n</steps>';
  }
  if (d.progress) {
    const status = typeof d.progress === 'string' ? d.progress : 'working';
    const goal = /<tracked_goal[^>]*>\n([\s\S]*?)\n<\/tracked_goal>/.exec(turn.briefing || '');
    text += `\n\n<progress status="${status}">${goal ? `“${goal[1].trim()}”` : 'No goal tracked'}: ${status} (${me}).</progress>`;
  }
  if (d.remember) text += `\n\n<remember scope="everywhere" basis="user">${said}</remember>`;
  if (d.secret) {
    const name = typeof d.secret === 'string' ? d.secret : 'E2E_TOKEN';
    text += `\n\n<secret name="${name}" label="E2E token">The fake needs it for the e2e check.</secret>`;
  }
  if (d.command) {
    const name = typeof d.command === 'string' ? d.command : 'e2e-check';
    text += `\n\n<command name="${name}" secrets="E2E_TOKEN">cat "$RELAY_SECRETS_FILE"; printf 'input: %s\\n' "$(cat)"</command>`;
  }
  if (d.commandrun) {
    const name = typeof d.commandrun === 'string' ? d.commandrun : 'e2e-check';
    text += `\n\n<command-run name="${name}">hello from the outbox</command-run>`;
  }
  if (d.interactive) text += `\n\n${INTERACTIVE[d.interactive === 'askpass' ? 'askpass' : 'device']}`;
  steps.push({ type: 'text', text, slow: slowMs(d.slow) });
  // After its answer, the turn waits for a message sent into it, and answers that too.
  if (d.steer) steps.push({ type: 'steer', wait: slowMs(d.steer) });
  return steps;
}

/** The long-term memory notes a turn was given (`<memory_notes>` in its briefing, `<recalled_memory>` in its prompt): their texts. */
function longTermIn(text) {
  const out = [];
  for (const block of text.matchAll(/<(memory_notes|recalled_memory)>\n([\s\S]*?)\n<\/\1>/g)) {
    for (const line of block[2].split('\n')) {
      const m = /^- \[m_[0-9a-f]+\] .* · \d{4}-\d{2}-\d{2}: (.*)$/.exec(line);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

/**
 * The lead agent tidying the long-term memory: it pins the first note an agent wrote that is not pinned
 * yet (the user's own it may not change), and says how many it read.
 */
function tidyReply(prompt) {
  const lines = tag(prompt, 'notes').split('\n').filter(Boolean);
  const first = lines.find((l) => !/ · pinned/.test(l) && !/ · the user · /.test(l));
  const id = first ? (/^- \[(m_[0-9a-f]+)\]/.exec(first) || [])[1] : undefined;
  return json({
    changes: id ? [{ op: 'pin', id }] : [],
    summary: `The fake lead agent read ${lines.length} ${lines.length === 1 ? 'note' : 'notes'}.`,
  });
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
        const first =
          body
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find(Boolean) || '';
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

/** How many pieces a slow reply comes in. */
const SLOW_PIECES = 40;

/**
 * How long a slow reply takes, in milliseconds (`e2e:slow`: about ten seconds; `e2e:slow=<seconds>`);
 * 0 for one that is not slow. A test that waits for the reply to end asks for a few seconds only.
 */
function slowMs(value) {
  if (!value) return 0;
  const seconds = value === true ? 10 : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 10_000;
}

/**
 * Pieces of `text` to stream: a few words each, or for a slow reply (`slow`, its milliseconds) as many
 * as spread it over its time: its first paragraph at once, then each further one in turn (a reply of
 * several grows as it streams; the first holds those there is no piece for), then small ones.
 */
function pieces(text, slow) {
  if (slow) {
    const paragraphs = text.split(/(?=\n\n)/);
    const extra = Math.max(0, paragraphs.length - SLOW_PIECES);
    const out = [paragraphs.slice(0, extra + 1).join(''), ...paragraphs.slice(extra + 1)];
    while (out.length < SLOW_PIECES) out.push(' …');
    return out;
  }
  const words = text.split(/(?<=\s)/);
  const out = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
  return out.length ? out : [text];
}
/** The wait after each piece: a slow reply's time spread over its pieces. */
const pieceDelay = (slow) => (slow ? slow / SLOW_PIECES : 15);

/**
 * The messages sent into a running turn (steering), as a fake that takes them keeps them: `take` one as
 * it comes (Harness Relay's text, with its id in the CLI's protocol), and a `steer` step `wait`s for one
 * (or its time); `rest` is what came and no step took, which the turn takes in before it ends. `heard`:
 * what the reply says about them.
 */
function steerBox() {
  const came = [];
  let wake;
  return {
    take(text, id) {
      const said = lastUserMessage(text);
      came.push({ id, text: said === undefined ? text : withoutDirectives(said) });
      record({ steered: text });
      if (wake) wake();
    },
    async wait(ms) {
      if (!came.length) {
        await new Promise((resolve) => {
          wake = resolve;
          setTimeout(resolve, ms).unref();
        });
      }
      wake = undefined;
      return came.splice(0);
    },
    rest: () => came.splice(0),
  };
}
const heard = (messages) => messages.map((m) => ` I also heard: “${m.text}”.`).join('');

/** The note the user gave with a decline, as Harness Relay passes it on ("Their message: …"). */
function noteIn(message) {
  const m = /Their message: (.*?)(?: Do not retry|$)/s.exec(String(message || ''));
  return m ? m[1].trim() : '';
}
const declined = (what, note) => `The ${what} was declined${note ? ` (the user said: ${note})` : ''}. `;
const noOther = (step) => `I was given no other working directory for ${step.path}. `;
const wrote = (step, ok, note) =>
  ok ? `I wrote ${step.path}. ` : `I may not write ${step.path} here${note ? ` (the user said: ${note})` : ''}. `;

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
  slowMs,
  noteIn,
  steerBox,
  heard,
  declined,
  noOther,
  wrote,
};
