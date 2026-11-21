/*
 * A tool library HTTP MCP server's own sign-in in a turn (`McpOAuth.forTurn()` in the orchestrator's turn
 * setup): the member's run gets the server with an access token in its `Authorization` header, and one
 * whose sign-in no longer works is left out of the turn, with a note in the reply (the user's) and in the
 * briefing (the agent's), kept on a reply whose agent passed; a member whose CLI takes no HTTP server
 * (Antigravity) gets no refresh, note or briefing line; a note does not count as the agent's words when a
 * resumed session fails and is started fresh. Against the stand-in MCP server and authorization server of
 * the MCP sign-in tests.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runners } from '../src/server/agents';
import { callbackParams } from '../src/server/oauth/signin';
import { fakeMcpAuth, type FakeMcpAuth } from './fake-mcp-auth-server';
import { agentMessages, agents, calls, conversation, fake, finish, orchestrator, settings, store, withLang } from './orchestrator-harness';

/** The server `linear` at the stand-in, given to these CLIs, signed in. */
async function signedIn(providers: ('claude' | 'antigravity')[] = ['claude']): Promise<{ id: string }> {
  auth = await fakeMcpAuth();
  settings.tools.saveServer('linear', { transport: 'http', url: auth.mcpUrl, headers: [], providers });
  const started = await settings.mcpOAuth.startSignIn({ name: 'linear', port: 8787 });
  await settings.oauth.signIns.callback(callbackParams(auth.allow(started.authorizeUrl!)));
  return started.server!;
}

let auth: FakeMcpAuth | undefined;
afterEach(async () => {
  await settings.mcpOAuth.settled();
  await auth?.close();
  auth = undefined;
});

describe("an MCP server's own sign-in in a turn", () => {
  it("gives the member its access token in the server's headers, and leaves it out, saying so, once its sign-in no longer works", async () => {
    auth = await fakeMcpAuth();
    settings.tools.saveServer('linear', { transport: 'http', url: auth.mcpUrl, headers: [], providers: ['claude'] });
    const started = await settings.mcpOAuth.startSignIn({ name: 'linear', port: 8787 });
    await settings.oauth.signIns.callback(callbackParams(auth.allow(started.authorizeUrl!)));
    const headers: Record<string, string>[] = [];
    fake.inTurn = async (_name, o) => void headers.push(o.mcpServers?.find((s) => s.name === 'linear')?.headers ?? {});

    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    conv.agents = [agents[0]!];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'hello');
    await finish(conv.id);
    expect(calls[0]!.mcpServers).toEqual(['linear']);
    expect(headers[0]!.Authorization).toMatch(/^Bearer mcp-access-/);
    expect(auth.accessTokens.get(headers[0]!.Authorization!.slice('Bearer '.length))).toBe(true);
    expect(agentMessages(conv)[0]!.parts.some((p) => p.type === 'notice')).toBe(false);

    // Revoked at its authorization server: the next turn's refresh is refused.
    auth.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } };
    settings.mcpOAuth.broker.forget(started.server!.id);
    await withLang('en', async () => {
      await orchestrator.send(conv.id, 'again');
      await finish(conv.id);
    });
    expect(calls[1]!.mcpServers).toBeUndefined();
    const reply = agentMessages(conv)[1]!;
    expect(reply.parts[0]).toEqual({
      type: 'notice',
      text: 'The MCP server "linear" was left out of this turn: its sign-in no longer works (invalid_grant). Sign in to it again in Settings → Apps and tools → Tool library → MCP servers.',
    });
    expect(reply.status).toBe('done');
    expect(calls[1]!.systemPrompt).toContain('# Tool library: left out of this turn');
    expect(calls[1]!.systemPrompt).toContain(
      '- linear: its sign-in no longer works; the user can sign in to it again in Settings → Apps and tools → Tool library → MCP servers',
    );
    // Kept with the reply, as the chat shows it again later.
    store.flushAll();
    expect(store.get(conv.id)!.messages.find((m) => m.id === reply.id)!.parts[0]).toMatchObject({ type: 'notice' });
    expect(settings.tools.view().mcpServers[0]!.oauth?.status).toBe('reauth');
  });

  it('keeps the note on a reply whose agent passed, and gives an Antigravity member no refresh, note or briefing line', async () => {
    const server = await signedIn(['claude', 'antigravity']);
    auth!.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } };
    settings.mcpOAuth.broker.forget(server.id);
    const saved = runners.antigravity;
    runners.antigravity = { ...runners.claude, provider: 'antigravity' };
    try {
      const conv = conversation({ mode: 'roundtable', permission: 'edit' });
      conv.agents = [agents[0]!, { id: 'g', name: 'Gina', provider: 'antigravity', role: '' }];
      store.saveMeta(conv);
      fake.reply = (name) => (name === 'Alice' ? '[PASS]' : `${name} done`);
      await withLang('en', async () => {
        await orchestrator.send(conv.id, 'hello');
        await finish(conv.id);
      });
      const [alice, gina] = agentMessages(conv);
      expect(alice).toMatchObject({ passed: true, status: 'done' });
      expect(alice!.parts[0]).toMatchObject({ type: 'notice', text: expect.stringContaining('"linear" was left out of this turn') });
      expect(gina!.parts.some((p) => p.type === 'notice')).toBe(false);
      expect(calls.find((c) => c.name === 'Gina')!.systemPrompt).not.toContain('left out of this turn');
      // One refresh, Alice's: none for Gina, whose CLI takes no HTTP MCP server.
      expect(auth!.requests.filter((r) => r.path === '/tenant/token' && r.body.includes('grant_type=refresh_token'))).toHaveLength(1);
    } finally {
      runners.antigravity = saved;
    }
  });

  it("starts a failed resumed session fresh, the reply's note not counting as the agent's words", async () => {
    const server = await signedIn();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    conv.agents = [agents[0]!];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    expect(conv.agentState.a!.sessionId).toBe('session-Alice');

    auth!.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } };
    settings.mcpOAuth.broker.forget(server.id);
    fake.fail = (_name, sessionId) => (sessionId ? new Error('no such session') : undefined);
    calls.length = 0;
    await orchestrator.send(conv.id, 'second');
    await finish(conv.id);
    expect(calls.map((c) => c.sessionId)).toEqual(['session-Alice', undefined]);
    const reply = agentMessages(conv).at(-1)!;
    expect(reply.status).toBe('done');
    expect(reply.parts.filter((p) => p.type === 'notice')).toHaveLength(1);
  });
});
