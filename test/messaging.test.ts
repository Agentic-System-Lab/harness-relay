import { describe, expect, it, vi } from 'vitest';
import { SlackPosting } from '../src/server/connectors/slack';
import { messagingTools } from '../src/server/connectors/messaging';
import type { TeamsPostTarget } from '../src/server/connectors/teams';
import type { SecretStore } from '../src/server/secrets';
import { t, withLang } from '../src/server/i18n';
import type { GatewayContext } from '../src/server/gateway';
import type { OutboxItem } from '../src/shared/types';

const token = 'xoxb-test-credential-123';
function setup() {
  const secrets = new Map<string, string>();
  const store: SecretStore = {
    storage: 'keychain',
    get: (name) => secrets.get(name) ?? null,
    set: (name, v) => {
      secrets.set(name, v);
    },
    delete: (name) => {
      secrets.delete(name);
    },
  };
  const state = { name: 'ops', user: 'UBOT', scopes: 'channels:read,chat:write', failedPost: false, revoked: false, postError: '' };
  const requests: { url: URL; args: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      args = JSON.parse(String(init?.body ?? '{}'));
    expect(url.origin).toBe('https://slack.com');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + token);
    requests.push({ url, args });
    if (url.pathname.endsWith('/auth.test'))
      return Response.json(
        { ok: true, team_id: 'T123', user_id: state.user, team: 'Work', user: 'Relay', url: 'https://work.slack.com/' },
        { headers: { 'x-oauth-scopes': state.scopes } },
      );
    if (state.revoked) return Response.json({ ok: false, error: 'token_revoked' });
    if (url.pathname.endsWith('/conversations.info'))
      return Response.json({ ok: true, channel: { id: url.searchParams.get('channel'), name: state.name } });
    if (state.postError) return Response.json({ ok: false, error: state.postError });
    if (state.failedPost) throw new Error(token);
    return Response.json({ ok: true, channel: args.channel, ts: '1.01' });
  };
  const slack = new SlackPosting(store, fetcher);
  const target: TeamsPostTarget = {
    kind: 'channel',
    teamId: 't',
    destinationId: 'c',
    tenantId: 'tenant',
    senderId: 'u',
    sender: 'sender@test',
    destination: 'Office / Studio',
  };
  const teams = { resolvePost: vi.fn(async () => target), sendPost: vi.fn(async () => {}) };
  const [slackTool, teamsTool] = messagingTools(slack, teams);
  return { slack, slackTool: slackTool!, teamsTool: teamsTool!, state, secrets, requests, teams };
}

describe('sending from Relay', () => {
  it('stores the Slack credential only in the secret store and pins workspace, sender and destination to the reviewed text', () =>
    withLang('en', async () => {
      const { slack, slackTool, state, requests, secrets } = setup();
      await expect(slack.connect('invalid')).rejects.toThrow('OAuth token');
      state.scopes = 'channels:read';
      await expect(slack.connect(token)).rejects.toThrow('chat:write');
      expect(secrets.size).toBe(0);
      state.scopes = 'chat:write,channels:read';
      expect(await slack.connect(token)).toEqual({ status: 'connected', workspace: 'Work', sender: 'Relay' });
      const lines = ['<@UOTHER> & a link https://example.test/', 'Second line', '✓'];
      const text = lines.join('\n');
      const proposal = await slackTool.prepare!(
        { destination: 'https://app.slack.com/client/T123/C123', text: lines.join('\r\n') },
        {} as GatewayContext,
      );
      expect(slackTool.tier).toBe('send');
      expect(proposal.preview.fields.map((f) => f.value)).toEqual(['Relay · UBOT', 'Work · T123', '#ops · C123']);
      expect(proposal.preview.body).toBe(text);
      expect(JSON.stringify(proposal)).not.toContain(token);
      expect(requests.some((r) => r.url.pathname.endsWith('chat.postMessage'))).toBe(false);
      const item = { preview: proposal.preview } as OutboxItem;
      const altered = { preview: { ...proposal.preview, fields: proposal.preview.fields.slice(1) } } as OutboxItem;
      await expect(slackTool.send!(proposal.args, altered)).rejects.toThrow('changed');
      state.name = 'renamed';
      await expect(slackTool.send!(proposal.args, item)).rejects.toThrow('changed');
      state.name = 'ops';
      await slackTool.send!(proposal.args, item);
      expect(requests.at(-1)?.args).toMatchObject({
        channel: 'C123',
        text,
        parse: 'none',
        mrkdwn: false,
        unfurl_links: false,
        blocks: [{ text: { type: 'plain_text', text } }],
      });
      slack.disconnect();
      await expect(slackTool.send!(proposal.args, item)).rejects.toThrow('Enable sending');
      await slack.connect(token);
      await expect(slackTool.send!(proposal.args, item)).rejects.toThrow('changed');
      expect(requests.filter((r) => r.url.pathname.endsWith('chat.postMessage'))).toHaveLength(1);
    }));
  it('clears a known-revoked credential so Settings can offer a new connection', async () => {
    const { slack, state } = setup();
    await slack.connect(token);
    state.revoked = true;
    await expect(slack.resolvePost('C123')).rejects.toThrow();
    expect(slack.view()).toEqual({ status: 'signed-out' });
  });
  it('rejects foreign links, credentials in links and invalid message bodies before looking up or posting', () =>
    withLang('en', async () => {
      const { slack, slackTool, requests } = setup();
      await slack.connect(token);
      for (const link of [
        'https://other.slack.com/archives/C123',
        'https://app.slack.com/client/TWRONG/C123',
        'https://foo@work.slack.com/archives/C123',
        'http://work.slack.com/archives/C123',
        'https://work.slack.com.example.org/archives/C123',
        '#random',
      ]) {
        await expect(slackTool.prepare!({ destination: link, text: 'Hi' }, {} as GatewayContext)).rejects.toThrow();
      }
      for (const text of [' ', 'a'.repeat(3001), '\ud800', 'a\u0000b', 'a\rb'])
        await expect(slackTool.prepare!({ destination: 'C123', text }, {} as GatewayContext)).rejects.toThrow();
      expect(requests).toHaveLength(1);
    }));
  it.each(['missing_scope', 'channel_not_found', 'not_in_channel', 'is_archived'])(
    'reports Slack’s %s without retrying or disconnecting',
    async (error) => {
      const { slack, state, requests } = setup();
      await slack.connect(token);
      const target = await slack.resolvePost('C123');
      state.postError = error;
      await expect(slack.sendPost(target, 'Reviewed')).rejects.toMatchObject({
        status: 400,
        message: error === 'missing_scope' ? t().slackScope : t().slackDestination,
      });
      expect(slack.view().status).toBe('connected');
      expect(requests.filter((r) => r.url.pathname.endsWith('chat.postMessage'))).toHaveLength(1);
    },
  );
  it('reports unknown Slack delivery after a transport failure without retry or exposing credentials', () =>
    withLang('en', async () => {
      const { slack, state, requests } = setup();
      await slack.connect(token);
      const target = await slack.resolvePost('C123');
      state.failedPost = true;
      await expect(slack.sendPost(target, 'Hello')).rejects.toThrow('Delivery is unconfirmed. Check Slack');
      expect(requests.filter((r) => r.url.pathname.endsWith('chat.postMessage'))).toHaveLength(1);
    }));
  it('a Teams draft reads only its destination and the confirmed action uses that exact snapshot and plain text', () =>
    withLang('en', async () => {
      const { teams, teamsTool } = setup();
      expect(teamsTool.tier).toBe('send');
      const proposal = await teamsTool.prepare!({ destination: 'a channel link', text: 'Line 1\r\nLine 2' }, {} as GatewayContext);
      expect(proposal.preview.body).toBe('Line 1\nLine 2');
      expect(proposal.args.text).toBe(proposal.preview.body);
      expect(teams.sendPost).not.toHaveBeenCalled();
      expect(proposal.preview.fields).toContainEqual({ label: 'New channel post', value: 'Office / Studio · c' });
      await expect(teamsTool.send!(proposal.args, { preview: { ...proposal.preview, body: 'changed' } } as OutboxItem)).rejects.toThrow(
        'changed',
      );
      await teamsTool.send!(proposal.args, { preview: proposal.preview } as OutboxItem);
      expect(teams.sendPost).toHaveBeenCalledExactlyOnceWith(proposal.args.target, proposal.preview.body);
    }));
});
