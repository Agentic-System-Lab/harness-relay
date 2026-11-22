/*
 * The lead agent helping outside a conversation's team: drafting a template, team checks and a schedule
 * for their editors, suggesting the sidebar's groups, naming new conversations; and a schedule a member
 * proposes in its reply, which the user creates or dismisses from its card.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/server/errors';
import {
  CHECKS_BRIEFING,
  ORGANIZER_BRIEFING,
  SCHEDULE_BRIEFING,
  TEMPLATE_BRIEFING,
  agentMessages,
  calls,
  conversation,
  fake,
  finish,
  orchestrator,
  project,
  root,
  settings,
  store,
  textOf,
  withLang,
} from './orchestrator-harness';

const json = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```';
const drafter = () => calls.filter((c) => c.name === 'drafter');
/**
 * Where a draft with no project runs, in an empty folder of its own: the data folder's `drafts/`, not
 * Harness Relay's temporary folder, which the agents' sandboxes may not read.
 */
const tmp = join(root, 'data', 'drafts');
const leftInTmp = () => (existsSync(tmp) ? readdirSync(tmp).filter((f) => f.startsWith('ask-')) : []);

describe('a template the lead agent drafts', () => {
  const blank = {
    name: '',
    description: '',
    agents: [
      { id: 'c1', name: 'Claude', provider: 'claude', role: '' },
      { id: 'c2', name: 'Codex', provider: 'codex', role: '' },
    ],
    settings: { mode: 'roundtable', rounds: 1, maxHops: 8 },
  };

  it('writes a new template whole, read-only, in an empty folder of its own that goes once it answers', async () => {
    fake.draftReply = json({
      name: 'PR review',
      description: 'Reviews a pull request from three sides.',
      mode: 'roundtable',
      rounds: 1,
      maxHops: 8,
      agents: [
        { name: 'Claude', provider: 'claude', role: 'Bug hunter.\nFind the bugs.' },
        { name: 'Security', provider: 'claude', role: 'Security reviewer.' },
      ],
      reason: 'Two sides are enough here.',
    });
    const r = await orchestrator.drafts.template({ request: '  a PR review team  ', ...blank });
    expect(r.name).toBe('PR review');
    expect(r.description).toBe('Reviews a pull request from three sides.');
    expect(r.reason).toBe('Two sides are enough here.');
    expect(r.agents.map((a) => [a.name, a.role])).toEqual([
      ['Claude', 'Bug hunter.\nFind the bugs.'],
      ['Security', 'Security reviewer.'],
    ]);
    // The member it kept is the same one (its id), the one it dropped is gone.
    expect(r.agents[0]!.id).toBe('c1');
    expect(r.meta?.costUsd).toBe(0.03);
    const [call] = drafter();
    expect(call).toMatchObject({ systemPrompt: TEMPLATE_BRIEFING, permission: 'read-only', freshState: true, stateKey: 'draft.template' });
    expect(call!.prompt).toContain('<request>\na PR review team\n</request>');
    expect(call!.prompt).toContain('a new one, whose members are only a starting point');
    expect(call!.cwd!.startsWith(tmp)).toBe(true);
    expect(existsSync(call!.cwd!)).toBe(false);
    expect(leftInTmp()).toEqual([]);
    expect(fake.schemas.drafter).toMatchObject({ required: expect.arrayContaining(['name', 'description', 'agents', 'reason']) });
  });

  it('changes only what is asked of a template with a team, and keeps its name and description when the lead gives none', async () => {
    fake.draftReply = json({ mode: 'relay', rounds: 1, maxHops: 4, agents: [{ name: 'Lead', provider: 'claude' }], reason: 'Relay now.' });
    const r = await orchestrator.drafts.template({
      request: 'make it a relay',
      name: 'Solo',
      description: 'One agent.',
      agents: [{ id: 'l', name: 'Lead', provider: 'claude', role: 'Lead it.' }],
      settings: { mode: 'roundtable', rounds: 2, maxHops: 8 },
    });
    expect(r).toMatchObject({ name: 'Solo', description: 'One agent.', settings: { mode: 'relay', maxHops: 4 } });
    expect(r.agents).toEqual([expect.objectContaining({ id: 'l', role: 'Lead it.' })]);
    expect(drafter()[0]!.prompt).not.toContain('only a starting point');
  });

  it("takes a new template's starting members on every CLI ready here, more than a team may have, and keeps the team within the limit", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Member${i}`, provider: 'claude', role: '' }));
    fake.draftReply = json({
      name: 'Big',
      agents: twelve.map((a) => ({ name: a.name, provider: 'claude', role: 'Do it.' })),
      reason: 'ok',
    });
    const r = await orchestrator.drafts.template({ request: 'a team', ...blank, agents: twelve });
    expect(r.agents).toHaveLength(8);
    await expect(
      orchestrator.drafts.template({
        request: 'a team',
        ...blank,
        agents: [...twelve, { id: 'x', name: 'X', provider: 'claude', role: '' }],
      }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses an empty or overlong request, and says why a draft failed', async () => {
    await expect(orchestrator.drafts.template({ request: ' ', ...blank })).rejects.toMatchObject({ status: 400 });
    await expect(orchestrator.drafts.template({ request: 'x'.repeat(4001), ...blank })).rejects.toMatchObject({ status: 400 });
    fake.draftFail = 'rate limited';
    const err = await orchestrator.drafts.template({ request: 'a team', ...blank }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as Error).message).toContain('rate limited');
    fake.draftFail = undefined;
    fake.draftReply = 'no JSON at all';
    await expect(orchestrator.drafts.template({ request: 'a team', ...blank })).rejects.toMatchObject({ status: 503 });
    expect(leftInTmp()).toEqual([]);
  });

  it('stops when the request is closed, and a new draft of its kind stops the one still running', async () => {
    let open!: () => void;
    fake.draftGate = new Promise((r) => (open = r));
    const ctrl = new AbortController();
    const first = orchestrator.drafts.template({ request: 'one', ...blank }, ctrl.signal);
    await vi.waitFor(() => expect(drafter()).toHaveLength(1));
    expect(orchestrator.busy()).toBe(1);
    ctrl.abort();
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(orchestrator.busy()).toBe(0);

    const second = orchestrator.drafts.template({ request: 'two', ...blank });
    await vi.waitFor(() => expect(drafter()).toHaveLength(2));
    fake.draftReply = json({ name: 'Third', agents: [], reason: 'ok' });
    const third = orchestrator.drafts.template({ request: 'three', ...blank });
    await expect(second).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(drafter()).toHaveLength(3));
    open();
    await expect(third).resolves.toMatchObject({ name: 'Third' });
    expect(drafter().map((c) => Boolean(c.aborted))).toEqual([true, true, false]);
  });
});

describe('team checks the lead agent drafts', () => {
  it("reads the conversation's project, read-only, and keeps the ids of the commands it kept", async () => {
    const other = join(project, '..', `${project.split(/[\\/]/).pop()}-other`);
    mkdirSync(other, { recursive: true });
    const conv = conversation({ extraCwds: [other] });
    fake.draftReply = json({
      protectedPaths: ['.env', 'package-lock.json'],
      commitPattern: '',
      commands: [
        { run: 'npm test', cwd: '', timeoutMin: null, localPorts: false, unixSockets: false },
        { run: 'npm run lint', cwd: '', timeoutMin: 5, localPorts: false, unixSockets: false },
      ],
      hooks: [],
      previewApp: false,
      autoFix: true,
      reason: 'Tests and lint, as the project runs them.',
    });
    const r = await orchestrator.drafts.checks({
      request: 'run the tests',
      variant: 'team',
      convId: conv.id,
      checks: { commands: [{ id: 'keep-me', run: 'npm test' }] },
    });
    expect(r.checks).toEqual({
      protectedPaths: ['.env', 'package-lock.json'],
      commands: [{ id: 'keep-me', run: 'npm test' }, expect.objectContaining({ run: 'npm run lint', timeoutMin: 5 })],
      autoFix: true,
    });
    expect(r.readIn).toBe(project);
    const [call] = drafter();
    expect(call).toMatchObject({
      systemPrompt: CHECKS_BRIEFING,
      cwd: project,
      addDirs: [other],
      permission: 'read-only',
      stateKey: `draft.checks.${conv.id}`,
    });
    expect(call!.prompt).toContain(`you are running in ${project}, read-only`);
    expect(call!.prompt).toContain('"run": "npm test"');
  });

  it("reads the new chat's folder, and no project when it does not exist or the list is a template's", async () => {
    fake.draftReply = json({ protectedPaths: ['.env'], reason: 'ok' });
    await orchestrator.drafts.checks({ request: 'protect secrets', variant: 'team', cwd: project });
    expect(drafter()[0]!.cwd).toBe(project);
    const r = await orchestrator.drafts.checks({ request: 'protect secrets', variant: 'team', cwd: join(project, 'not-made-yet') });
    expect(r.readIn).toBeUndefined();
    expect(drafter()[1]!.cwd!.startsWith(tmp)).toBe(true);
    await orchestrator.drafts.checks({ request: 'protect secrets', variant: 'template', cwd: project });
    expect(drafter()[2]!.cwd!.startsWith(tmp)).toBe(true);
    expect(drafter()[2]!.prompt).toContain('This is the list of a team template');
    expect(leftInTmp()).toEqual([]);
  });

  it('leaves out a rule it cannot use, says so, and keeps the default list’s hooks as they are', async () => {
    fake.draftReply = json({
      protectedPaths: ['/abs/../../etc', '.env'],
      commitPattern: '(unclosed',
      commands: [{ run: '' }, { run: 'make check' }],
      hooks: [{ when: 'before', tools: 'command', run: 'echo hi' }],
      reason: 'Done.',
    });
    const r = await withLang('en', () =>
      orchestrator.drafts.checks({
        request: 'checks',
        variant: 'defaults',
        checks: { hooks: [{ id: 'h1', when: 'after', tools: 'any', run: 'x' }] },
      }),
    );
    expect(r.checks.protectedPaths).toEqual(['.env']);
    expect(r.checks.commitPattern).toBeUndefined();
    expect(r.checks.commands?.map((c) => c.run)).toEqual(['make check']);
    expect(r.checks.hooks).toEqual([{ id: 'h1', when: 'after', tools: 'any', run: 'x' }]);
    expect(r.reason).toBe('Done. 3 rules could not be used and were left out.');
    expect(drafter()[0]!.prompt).toContain('Leave "hooks" empty');
  });

  it('is not found for a conversation that is not there', async () => {
    await expect(orchestrator.drafts.checks({ request: 'x', variant: 'team', convId: 'nope' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('a schedule the lead agent drafts', () => {
  const now = Date.UTC(2026, 10, 23, 1, 0); // Monday 23 November 2026, 09:00 in Taipei

  it('fills in the message and the times in the browser’s time zone, for the conversation’s team', async () => {
    const conv = conversation({});
    fake.draftReply = json({
      text: "Sum up yesterday's merged pull requests.",
      repeat: { kind: 'once', at: '2026-11-24T09:30', time: null, days: null, hours: null, triggers: null },
      goal: '',
      newChat: true,
      missed: 'run',
      approvals: 'ask',
      reason: 'Tomorrow at 9:30.',
    });
    const r = await orchestrator.drafts.schedule({ request: 'tomorrow 9:30', timeZone: 'Asia/Taipei', convId: conv.id }, undefined, now);
    expect(r.schedule).toEqual({
      text: "Sum up yesterday's merged pull requests.",
      repeat: { kind: 'once', at: Date.UTC(2026, 10, 24, 1, 30) },
      timeZone: 'Asia/Taipei',
      enabled: true,
      approvals: 'ask',
      missed: 'run',
      newChat: true,
    });
    const [call] = drafter();
    expect(call).toMatchObject({ systemPrompt: SCHEDULE_BRIEFING, stateKey: `draft.schedule.${conv.id}` });
    expect(call!.prompt).toContain("It is now Monday, 2026-11-23 09:00 in the user's time zone (Asia/Taipei)");
    expect(call!.prompt).toContain("the conversation's team (@Alice, @Bob)");
    expect(call!.prompt).toContain('(none: a mail trigger\'s account is ""');
  });

  it("keeps a trigger's account only when it is set up, picks the only one there is, and refuses a time that passed", async () => {
    settings.connectors.saveMail('work', {
      name: 'Work',
      address: 'me@work.example',
      username: 'me@work.example',
      password: 'app-pass',
      imap: { host: '127.0.0.1', port: 1, security: 'none' },
      smtp: { host: '127.0.0.1', port: 2, security: 'none' },
    });
    fake.draftReply = json({
      text: 'Answer the new mail.',
      repeat: {
        kind: 'event',
        triggers: [
          { source: 'mail', account: 'made-up', folder: 'INBOX', from: 'boss' },
          { source: 'calendar', account: 'cal', minutes: 10 },
        ],
      },
      reason: 'When mail comes.',
    });
    const r = await orchestrator.drafts.schedule({ request: 'when mail comes', timeZone: 'Asia/Taipei' }, undefined, now);
    expect(r.schedule.repeat).toEqual({
      kind: 'event',
      triggers: [
        { source: 'mail', account: 'work', folder: 'INBOX', from: 'boss' },
        { source: 'calendar', account: '', minutes: 10 },
      ],
    });
    expect(drafter()[0]!.prompt).toContain('- "work": Work (me@work.example)');
    expect(drafter()[0]!.prompt).toContain('a new automation: once the user saves it, you design the team');

    fake.draftReply = json({ text: 'Too late.', repeat: { kind: 'once', at: '2026-11-22T09:00' }, reason: 'x' });
    await expect(orchestrator.drafts.schedule({ request: 'yesterday', timeZone: 'Asia/Taipei' }, undefined, now)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('the sidebar groups the lead agent suggests', () => {
  it('reads the groups and one conversation for each family, and keeps only suggestions that can be taken', async () => {
    store.createGroup({ id: 'g1', name: 'Work' });
    const a = conversation({});
    const b = conversation({});
    store.moveToGroup(b.id, 'g1');
    a.title = 'Invoice for ACME';
    a.updatedAt = 1;
    b.title = 'Fix the build';
    b.updatedAt = 2;
    store.saveMeta(a);
    store.saveMeta(b);
    fake.draftReply = json({
      create: [{ name: 'Clients' }, { name: 'work' }],
      rename: [
        { group: 1, name: 'Engineering' },
        { group: 9, name: 'Nothing' },
      ],
      move: [
        { conversation: 2, group: 2 },
        { conversation: 1, group: 1 },
        { conversation: 7, group: 0 },
      ],
      reason: 'Clients apart from engineering.',
    });
    const r = await orchestrator.drafts.groups({});
    // Newest first: b was saved last.
    const prompt = drafter()[0]!.prompt;
    expect(prompt).toContain('1. "Work" (1 of the conversations below)');
    expect(prompt).toMatch(/1\. "Fix the build": group 1\n2\. "Invoice for ACME": Other/);
    expect(drafter()[0]).toMatchObject({ systemPrompt: ORGANIZER_BRIEFING, stateKey: 'draft.groups' });
    // "work" is the name of a group (renamed or not), conversation 1 is in group 1 already, 7 is not there.
    expect(r.create).toEqual([{ key: 'new-1', name: 'Clients' }]);
    expect(r.rename).toEqual([{ id: 'g1', from: 'Work', name: 'Engineering' }]);
    expect(r.move).toEqual([{ convId: a.id, title: 'Invoice for ACME', from: null, to: 'new-1' }]);
  });

  it('has nothing to organize without conversations', async () => {
    await expect(orchestrator.drafts.groups({})).rejects.toMatchObject({ status: 400 });
    expect(drafter()).toHaveLength(0);
  });
});

describe('a schedule a member proposes', () => {
  const proposal = { text: 'Check the build', repeat: { kind: 'daily', time: '08:00' } };

  it('becomes a card in place of its block, which waits for the user and tells teammates', async () => {
    const conv = conversation({ mode: 'roundtable' });
    fake.reply = (name) =>
      name === 'Alice' ? `I can do that every morning.\n\n<schedule>${JSON.stringify(proposal)}</schedule>` : undefined;
    await orchestrator.send(conv.id, 'check the build every morning');
    await finish(conv.id);
    const [alice, bob] = agentMessages(conv);
    expect(textOf(alice!)).toBe('I can do that every morning.');
    expect(alice!.parts.at(-1)).toEqual({ type: 'schedule', proposal });
    expect(orchestrator.proposalOf(conv.id, alice!.id)).toEqual(proposal);
    // Bob read Alice's reply with what she proposed.
    const bobCall = calls.find((c) => c.name === 'Bob')!;
    expect(bobCall.prompt).toContain('<proposed_schedule status="waiting for the user">');
    expect(bob!.parts.some((p) => p.type === 'schedule')).toBe(false);

    orchestrator.markProposal(conv.id, alice!.id, 'dismissed');
    expect(alice!.parts.at(-1)).toEqual({ type: 'schedule', proposal, status: 'dismissed' });
    expect(() => orchestrator.proposalOf(conv.id, alice!.id)).toThrow(expect.objectContaining({ status: 409 }));
    // Kept with the message.
    const kept = store.get(conv.id)!.messages.find((m) => m.id === alice!.id)!;
    expect(kept.parts.at(-1)).toEqual({ type: 'schedule', proposal, status: 'dismissed' });
  });

  it('becomes a card also in a reply that failed after writing it, whose block never shows as text', async () => {
    const conv = conversation({ mode: 'parallel' });
    fake.inTurn = async (name, o) => {
      if (name !== 'Alice') return;
      o.onEvent({ type: 'text', text: `On it.\n<schedule>${JSON.stringify(proposal)}</schedule>` });
      throw new Error('the model went away');
    };
    await orchestrator.send(conv.id, 'every morning, please');
    await finish(conv.id);
    const alice = agentMessages(conv).find((m) => m.author.kind === 'agent' && m.author.agentId === 'a')!;
    expect(alice.status).toBe('error');
    expect(textOf(alice)).toBe('On it.');
    expect(alice.parts.at(-1)).toEqual({ type: 'schedule', proposal });
  });

  it('leaves a block it cannot read in the reply, so the mistake shows', async () => {
    const conv = conversation({ mode: 'parallel' });
    fake.reply = () => 'Here: <schedule>{"text": "x", "repeat": {"kind": "hourly"}}</schedule>';
    await orchestrator.send(conv.id, 'hourly please');
    await finish(conv.id);
    const reply = agentMessages(conv)[0]!;
    expect(textOf(reply)).toContain('<schedule>');
    expect(reply.parts.some((p) => p.type === 'schedule')).toBe(false);
    expect(() => orchestrator.proposalOf(conv.id, reply.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('is described in the briefing', async () => {
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'hello');
    await finish(conv.id);
    expect(calls.find((c) => c.name === 'Alice')!.systemPrompt).toContain('you can propose a schedule for this chat');
  });
});

describe('naming new conversations', () => {
  const newChat = () => {
    const conv = conversation({ mode: 'parallel' });
    conv.title = withLang('en', () => 'New chat');
    store.saveMeta(conv);
    return conv;
  };
  const sorter = () => calls.filter((c) => c.name === 'sorter');

  it('names a new chat after its first message, once, in the background, when that is on', async () => {
    settings.setChatTitles(true);
    fake.sorterReply = '{"title": "  “Build check every morning.”  "}';
    const conv = newChat();
    await orchestrator.send(conv.id, 'can you check the build every morning and tell me what broke');
    await finish(conv.id);
    await vi.waitFor(() => expect(store.get(conv.id)!.title).toBe('Build check every morning'));
    expect(sorter()).toHaveLength(1);
    expect(sorter()[0]!.prompt).toContain('Give the conversation a title for the sidebar');
    expect(sorter()[0]!.prompt).not.toContain('The user sorts conversations into these groups');
    expect(fake.schemas.sorter).toMatchObject({ required: ['title'] });
    await orchestrator.send(conv.id, 'and on Fridays too');
    await finish(conv.id);
    expect(sorter()).toHaveLength(1);
  });

  it('asks for the group and the title in one run when there are groups', async () => {
    settings.setChatTitles(true);
    store.createGroup({ id: 'g1', name: 'Builds' });
    fake.sorterReply = '{"group": 1, "title": "Morning build check"}';
    const conv = newChat();
    await orchestrator.send(conv.id, 'check the build');
    await finish(conv.id);
    await vi.waitFor(() => expect(store.get(conv.id)!.title).toBe('Morning build check'));
    expect(store.groupOf(conv.id)).toBe('g1');
    expect(sorter()).toHaveLength(1);
    expect(fake.schemas.sorter).toMatchObject({ required: ['group', 'title'] });
  });

  it('keeps a title the user typed meanwhile, and one given at the start', async () => {
    settings.setChatTitles(true);
    let open!: () => void;
    fake.sorterGate = new Promise((r) => (open = r));
    fake.sorterReply = '{"title": "From the lead"}';
    const conv = newChat();
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(sorter()).toHaveLength(1));
    conv.title = 'Mine';
    store.saveMeta(conv);
    open();
    await vi.waitFor(() => expect(orchestrator.busy()).toBe(0));
    expect(store.get(conv.id)!.title).toBe('Mine');

    const titled = conversation({ mode: 'parallel' });
    await orchestrator.send(titled.id, 'another question');
    await finish(titled.id);
    expect(sorter()).toHaveLength(1);
  });

  it('says the conversation is being sorted only while the run sorts it, not while it only names it', async () => {
    settings.setChatTitles(true);
    let open!: () => void;
    fake.sorterGate = new Promise((r) => (open = r));
    fake.sorterReply = '{"title": "Named"}';
    const conv = newChat();
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(sorter()).toHaveLength(1));
    expect(orchestrator.isSorting(conv.id)).toBe(false);
    // Still work under way, which the desktop app's update waits for.
    expect(orchestrator.busy()).toBeGreaterThan(0);
    open();
    await vi.waitFor(() => expect(store.get(conv.id)!.title).toBe('Named'));

    store.createGroup({ id: 'g1', name: 'Builds' });
    fake.sorterGate = new Promise((r) => (open = r));
    const sorted = newChat();
    await orchestrator.send(sorted.id, 'check the build');
    await vi.waitFor(() => expect(sorter()).toHaveLength(2));
    expect(orchestrator.isSorting(sorted.id)).toBe(true);
    open();
    await vi.waitFor(() => expect(orchestrator.isSorting(sorted.id)).toBe(false));
  });

  it('runs no lead agent for it when it is off and there are no groups', async () => {
    settings.setChatTitles(false);
    const conv = newChat();
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    expect(sorter()).toHaveLength(0);
    expect(store.get(conv.id)!.title).toBe('first question');
  });
});

it('writes nothing into the project while drafting its checks', async () => {
  writeFileSync(join(project, 'package.json'), '{"scripts": {"test": "vitest"}}');
  fake.draftReply = json({ commands: [{ run: 'npm test' }], reason: 'ok' });
  const conv = conversation({});
  await orchestrator.drafts.checks({ request: 'tests', variant: 'team', convId: conv.id });
  expect(readdirSync(project).sort()).toEqual(['package.json', 'shared.txt']);
});

it('refuses new drafts once shutting down, and waits for the ones under way', async () => {
  let open!: () => void;
  fake.draftGate = new Promise((r) => (open = r));
  const conv = conversation({});
  const running = orchestrator.drafts.checks({ request: 'tests', variant: 'team', convId: conv.id });
  await vi.waitFor(() => expect(drafter()).toHaveLength(1));
  orchestrator.stopAll();
  await expect(running).rejects.toMatchObject({ status: 409 });
  await expect(orchestrator.drafts.groups({})).rejects.toMatchObject({ status: 503 });
  await orchestrator.settled(5_000);
  expect(orchestrator.busy()).toBe(0);
  open();
});
