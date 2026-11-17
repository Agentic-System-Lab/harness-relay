/*
 * Harness Relay's own tools in a turn: the gateway's grant given to the run (its MCP server among the
 * agent's), ended with the turn; an approval the CLI asked about not asked again by the gateway; and
 * the outbox: a `send` call's card in the reply, the conversation waiting for the user, and their Send.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { describe, expect, it } from 'vitest';
import type { OutboxItem, RelayToolGroup } from '../src/shared/types';
import type { GatewayContext, GatewayTool, ToolGateway } from '../src/server/gateway';
import { Outbox } from '../src/server/outbox';
import { agents, calls, conversation, db, fake, finish, orchestrator, settings, store, textOf, withLang } from './orchestrator-harness';

describe("Harness Relay's own tools in a turn", () => {
  /** A stand-in gateway: it records each grant, and knows one tool that sends. */
  const fakeGateway = () => {
    const grants: { ctx: GatewayContext; groups: readonly RelayToolGroup[]; revoked: boolean }[] = [];
    const sent: Record<string, unknown>[] = [];
    const mailTool = { name: 'mail_send', group: 'mail', tier: 'send', send: async (args: Record<string, unknown>) => (sent.push(args), 'accepted by the server') } as unknown as GatewayTool;
    const gateway = {
      grant(ctx: GatewayContext, groups: readonly RelayToolGroup[]) {
        const g = { ctx, groups, revoked: false };
        grants.push(g);
        return { spec: { name: 'relay', transport: 'stdio' as const, command: 'node', args: ['relay-mcp.mjs'], url: '', env: {}, headers: {} }, revoke: () => (g.revoked = true) };
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

  it("gives a member the gateway for the groups its CLI was given, for its turn alone, and none without a group", async () => {
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

    // A member turned off its groups gets none.
    conv.agents = [{ ...agents[0]!, tools: { 'relay:browser': false, 'relay:mail': false } }];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    expect(calls[2]!.mcpServers).toBeUndefined();
  });

  it('does not ask again for a tool of its own the user just allowed when the CLI asked, and only once', async () => {
    const { grants } = fakeGateway();
    settings.tools.update({ relayTools: { browser: ['claude'] } });
    const conv = solo();
    conv.allowRules = [{ kind: 'other', key: 'mcp__relay__browser_click' }];
    store.saveMeta(conv);
    const seen: boolean[] = [];
    fake.inTurn = async (_name, o) => {
      await o.requestApproval!({ kind: 'other', tool: 'mcp__relay__browser_click', detail: '{"ref":3}' });
      seen.push(grants[0]!.ctx.justAllowed!('browser_click'), grants[0]!.ctx.justAllowed!('browser_click'), grants[0]!.ctx.justAllowed!('mail_send'));
    };
    await orchestrator.send(conv.id, 'click it');
    await finish(conv.id);
    expect(seen).toEqual([true, false, false]);
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
        items.push(ctx.toOutbox!({ tool: 'mail_send', title: 'Mail to bob@example.com', preview, args: { to: 'bob@example.com', body: 'Hi Bob' } }));
        // The same call again (a run tried again, say) is the item already waiting, with no second card.
        items.push(ctx.toOutbox!({ tool: 'mail_send', title: 'Mail to bob@example.com', preview, args: { body: 'Hi Bob', to: 'bob@example.com' } }));
      };
      await orchestrator.send(conv.id, 'mail Bob');
      await finish(conv.id);
      expect(items[0]!.id).toBe(items[1]!.id);
      const reply = conv.messages.find((m) => m.author.kind === 'agent')!;
      expect(reply.parts.filter((p) => p.type === 'outbox')).toEqual([
        { type: 'outbox', id: items[0]!.id, tool: 'mail_send', title: 'Mail to bob@example.com', preview: { fields: [{ label: 'To', value: 'bob@example.com' }], body: 'Hi Bob' }, status: 'pending' },
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
});
