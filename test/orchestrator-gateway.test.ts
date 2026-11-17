/*
 * Harness Relay's own tools in a turn: the gateway's grant given to the run (its MCP server among the
 * agent's), ended with the turn; the CLI's own question about one of them answered yes (the gateway
 * decides by tier); and
 * the outbox: a `send` call's card in the reply, the conversation waiting for the user, and their Send.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { describe, expect, it } from 'vitest';
import type { OutboxItem, RelayToolGroup } from '../src/shared/types';
import type { GatewayContext, GatewayTool, ToolGateway } from '../src/server/gateway';
import { Outbox } from '../src/server/outbox';
import {
  agents,
  calls,
  conversation,
  db,
  fake,
  finish,
  orchestrator,
  runners,
  settings,
  store,
  textOf,
  withLang,
} from './orchestrator-harness';

describe("Harness Relay's own tools in a turn", () => {
  /** A stand-in gateway: it records each grant, and knows one tool that sends. */
  const fakeGateway = () => {
    const grants: { ctx: GatewayContext; groups: readonly RelayToolGroup[]; revoked: boolean }[] = [];
    const sent: Record<string, unknown>[] = [];
    const mailTool = {
      name: 'mail_send',
      group: 'mail',
      tier: 'send',
      send: async (args: Record<string, unknown>) => (sent.push(args), 'accepted by the server'),
    } as unknown as GatewayTool;
    const gateway = {
      grant(ctx: GatewayContext, groups: readonly RelayToolGroup[]) {
        const g = { ctx, groups, revoked: false };
        grants.push(g);
        return {
          spec: { name: 'relay', transport: 'stdio' as const, command: 'node', args: ['relay-mcp.mjs'], url: '', env: {}, headers: {} },
          revoke: () => (g.revoked = true),
        };
      },
      toolNames: () => ['browser_click', 'mail_send'],
      tool: (name: string) => (name === 'mail_send' ? mailTool : undefined),
    } as unknown as ToolGateway;
    orchestrator.gateway = gateway;
    orchestrator.outbox = new Outbox(db);
    return { grants, sent };
  };
  const solo = () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    conv.agents = [agents[0]!];
    store.saveMeta(conv);
    return conv;
  };

  it('gives a member the gateway for the groups its CLI was given, for its turn alone, and none without a group', async () => {
    const { grants } = fakeGateway();
    const conv = solo();
    await orchestrator.send(conv.id, 'hello');
    await finish(conv.id);
    expect(calls[0]!.mcpServers).toBeUndefined();
    expect(grants).toEqual([]);

    settings.tools.update({ relayTools: { browser: ['claude'], mail: ['claude'] } });
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(calls[1]!.mcpServers).toEqual(['relay']);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.groups).toEqual(['browser', 'mail']);
    expect(grants[0]!.ctx).toMatchObject({ convId: conv.id, agentId: 'a', agentName: 'Alice', permission: 'edit', unattended: false });
    expect(grants[0]!.ctx.messageId).toBe(conv.messages.at(-1)!.id);
    expect(grants[0]!.revoked).toBe(true);

    // Grok gets them in full access only: below it, its sandbox keeps its MCP servers out of data/tmp.
    const saved = runners.grok;
    runners.grok = { ...runners.claude, provider: 'grok' };
    try {
      const grok = conversation({ mode: 'roundtable', permission: 'edit' });
      grok.agents = [{ ...agents[0]!, provider: 'grok' }];
      store.saveMeta(grok);
      settings.tools.update({ relayTools: { browser: ['claude', 'grok'], mail: ['claude'] } });
      const before = grants.length;
      await orchestrator.send(grok.id, 'below full access');
      await finish(grok.id);
      expect(calls.at(-1)!.mcpServers).toBeUndefined();
      expect(grants).toHaveLength(before);
      grok.settings.permission = 'full';
      store.saveMeta(grok);
      await orchestrator.send(grok.id, 'in full access');
      await finish(grok.id);
      expect(calls.at(-1)!.mcpServers).toEqual(['relay']);
      expect(grants.at(-1)!.groups).toEqual(['browser']);
    } finally {
      runners.grok = saved;
    }

    // A member turned off its groups gets none.
    conv.agents = [{ ...agents[0]!, tools: { 'relay:browser': false, 'relay:mail': false } }];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    expect(calls.at(-1)!.mcpServers).toBeUndefined();
  });

  it("answers a CLI's own question about one of its tools yes, with no card, and leaves every other question as it was", async () => {
    const { grants } = fakeGateway();
    settings.tools.update({ relayTools: { browser: ['claude'], mail: ['claude'] } });
    const conv = solo();
    const answers: boolean[] = [];
    fake.inTurn = async (_name, o) => {
      // As the CLIs ask: Claude Code's name with no detail, Codex's `relay:<tool>`; the gateway decides by tier then.
      answers.push((await o.requestApproval!({ kind: 'other', tool: 'mcp__relay__browser_click' })).allow);
      answers.push((await o.requestApproval!({ kind: 'other', tool: 'relay:mail_send', detail: '{"to":"bob@example.com"}' })).allow);
    };
    await orchestrator.send(conv.id, 'click it');
    await finish(conv.id);
    expect(answers).toEqual([true, true]);
    expect(conv.messages.at(-1)!.parts.some((p) => p.type === 'approval')).toBe(false);
    // The gateway itself still asks about an act below full access, through the turn's own question.
    expect(grants[0]!.ctx.ask).toBeTypeOf('function');
  });

  it('answers them in a conversation that refuses every question too, where anything else is refused as before', async () => {
    fakeGateway();
    const conv = conversation({ mode: 'roundtable', permission: 'edit', approvals: 'deny' });
    conv.agents = [agents[0]!];
    store.saveMeta(conv);
    const seen: (boolean | undefined)[] = [];
    fake.inTurn = async (_name, o) => {
      if (!o.requestApproval) return void seen.push(undefined);
      seen.push((await o.requestApproval({ kind: 'other', tool: 'mcp__relay__mail_send' })).allow);
      seen.push((await o.requestApproval({ kind: 'other', tool: 'mcp__evil__mail_send' })).allow);
      seen.push((await o.requestApproval({ kind: 'command', command: 'npm publish', tool: 'mcp__relay__mail_send' })).allow);
    };
    // Without Harness Relay's tools the turn has no one to ask, as before.
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    settings.tools.update({ relayTools: { mail: ['claude'] } });
    await orchestrator.send(conv.id, 'second');
    await finish(conv.id);
    expect(seen).toEqual([undefined, true, false, false]);
    expect(conv.messages.some((m) => m.parts.some((p) => p.type === 'approval'))).toBe(false);
  });

  it("puts a send call's card in the reply, keeps the chat waiting for the user, and sends it on their Send", () =>
    withLang('en', async () => {
      const { grants, sent } = fakeGateway();
      settings.tools.update({ relayTools: { mail: ['claude'] } });
      const conv = solo();
      const items: OutboxItem[] = [];
      fake.inTurn = async () => {
        const ctx = grants.at(-1)!.ctx;
        const preview = { fields: [{ label: 'To', value: 'bob@example.com' }], body: 'Hi Bob' };
        items.push(
          ctx.toOutbox!({ tool: 'mail_send', title: 'Mail to bob@example.com', preview, args: { to: 'bob@example.com', body: 'Hi Bob' } }),
        );
        // The same call again (a run tried again, say) is the item already waiting, with no second card.
        items.push(
          ctx.toOutbox!({ tool: 'mail_send', title: 'Mail to bob@example.com', preview, args: { body: 'Hi Bob', to: 'bob@example.com' } }),
        );
      };
      await orchestrator.send(conv.id, 'mail Bob');
      await finish(conv.id);
      expect(items[0]!.id).toBe(items[1]!.id);
      const reply = conv.messages.find((m) => m.author.kind === 'agent')!;
      expect(reply.parts.filter((p) => p.type === 'outbox')).toEqual([
        {
          type: 'outbox',
          id: items[0]!.id,
          tool: 'mail_send',
          title: 'Mail to bob@example.com',
          preview: { fields: [{ label: 'To', value: 'bob@example.com' }], body: 'Hi Bob' },
          status: 'pending',
        },
      ]);
      expect(orchestrator.isWaiting(conv.id)).toBe(true);
      expect(sent).toEqual([]);

      const done = await orchestrator.answerOutbox(conv.id, items[0]!.id, 'send');
      expect(done).toMatchObject({ status: 'sent', result: 'accepted by the server' });
      expect(sent).toEqual([{ to: 'bob@example.com', body: 'Hi Bob' }]);
      expect(reply.parts.find((p) => p.type === 'outbox')).toMatchObject({ status: 'sent', result: 'accepted by the server' });
      expect(textOf(conv.messages.at(-1)!)).toBe('Sent "Mail to bob@example.com": accepted by the server');
      expect(orchestrator.isWaiting(conv.id)).toBe(false);
      await expect(orchestrator.answerOutbox(conv.id, items[0]!.id, 'send')).rejects.toMatchObject({ status: 409 });
      await expect(orchestrator.answerOutbox('missing', items[0]!.id, 'send')).rejects.toMatchObject({ status: 404 });
    }));

  /** A conversation whose reply left a mail waiting in the outbox. */
  const waitingMail = async () => {
    const { grants, sent } = fakeGateway();
    settings.tools.update({ relayTools: { mail: ['claude'] } });
    const conv = solo();
    const items: OutboxItem[] = [];
    fake.inTurn = async () => {
      const preview = { fields: [{ label: 'To', value: 'bob@example.com' }] };
      items.push(grants.at(-1)!.ctx.toOutbox!({ tool: 'mail_send', title: 'Mail to Bob', preview, args: { to: 'bob@example.com' } }));
    };
    await orchestrator.send(conv.id, 'mail Bob');
    await finish(conv.id);
    return { conv, items, sent, reply: conv.messages.find((m) => m.author.kind === 'agent')! };
  };

  it('discards what a reply had waiting when the reply is taken back, so the reply that comes again asks anew', () =>
    withLang('en', async () => {
      const { conv, items, reply } = await waitingMail();
      expect(orchestrator.outbox!.waiting(conv.id)).toBe(1);
      await orchestrator.retry(conv.id, reply.id);
      await finish(conv.id);
      expect(orchestrator.outbox!.get(items[0]!.id)).toMatchObject({
        status: 'discarded',
        result: 'The reply that asked for it was taken back, so it was not sent.',
      });
      // The same call from the reply that came again: a new item, with its card.
      expect(items[1]!.id).not.toBe(items[0]!.id);
      const again = conv.messages.find((m) => m.author.kind === 'agent')!;
      expect(again.id).not.toBe(reply.id);
      expect(again.parts.filter((p) => p.type === 'outbox')).toMatchObject([{ id: items[1]!.id, status: 'pending' }]);
      expect(orchestrator.outbox!.waiting(conv.id)).toBe(1);
    }));

  it('copies no waiting card into a branch, whose item stays with the conversation it came from', async () => {
    const { conv, items, reply } = await waitingMail();
    const branch = await orchestrator.branch(conv.id, reply.id);
    const copied = branch.messages.find((m) => m.author.kind === 'agent')!;
    expect(copied.parts.some((p) => p.type === 'outbox')).toBe(false);
    expect(orchestrator.isWaiting(branch.id)).toBe(false);
    expect(reply.parts.find((p) => p.type === 'outbox')).toMatchObject({ id: items[0]!.id, status: 'pending' });
    expect(orchestrator.isWaiting(conv.id)).toBe(true);
  });

  it('brings the card of an item a stop of the server cut off while sending up to date at the next start', () =>
    withLang('en', async () => {
      const { conv, items, reply, sent } = await waitingMail();
      db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(items[0]!.id);
      // The next start: the item is marked failed, and its card says so.
      orchestrator.outbox = new Outbox(db);
      orchestrator.reconcileOutbox();
      expect(reply.parts.find((p) => p.type === 'outbox')).toMatchObject({ status: 'failed', result: expect.stringMatching(/not known/) });
      expect(
        store
          .get(conv.id)!
          .messages.find((m) => m.id === reply.id)!
          .parts.find((p) => p.type === 'outbox'),
      ).toMatchObject({ status: 'failed' });
      await expect(orchestrator.answerOutbox(conv.id, items[0]!.id, 'send')).rejects.toMatchObject({ status: 409 });
      expect(sent).toEqual([]);
    }));
});
