import { randomUUID } from 'node:crypto';
import type { SlackPostingConnection } from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { SecretStore } from '../secrets';
import { answerText } from './caldav';

const SECRET = 'slack.posting';
const CHANNEL = /^[CGD][A-Z0-9]{2,31}$/;

interface Credential {
  token: string;
  revision: string;
  teamId: string;
  userId: string;
  workspace: string;
  sender: string;
  host: string;
}

export interface SlackPostTarget {
  revision: string;
  teamId: string;
  userId: string;
  workspace: string;
  sender: string;
  channel: string;
  destination: string;
}

function channelId(input: string, identity: Credential): string {
  if (CHANNEL.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port) {
      const parts = url.pathname.split('/');
      const channel =
        url.hostname === 'app.slack.com' && parts[1] === 'client' && parts[2] === identity.teamId
          ? parts[3]
          : url.hostname === identity.host && parts[1] === 'archives'
            ? parts[2]
            : '';
      if (channel && CHANNEL.test(channel)) return channel;
    }
  } catch {
    /* The field error also covers links to another workspace. */
  }
  throw new HttpError(400, t().slackDestination);
}

/** The credential stays in Relay's secret store. No provider URL comes from the assistant. */
export class SlackPosting {
  private operation = 0;
  constructor(
    private secrets?: SecretStore,
    private fetcher: typeof fetch = fetch,
  ) {}

  private saved(): Credential | undefined {
    const value = this.secrets?.get(SECRET);
    return value ? (JSON.parse(value) as Credential) : undefined;
  }

  view(): SlackPostingConnection {
    const saved = this.saved();
    return saved ? { status: 'connected', workspace: saved.workspace, sender: saved.sender } : { status: 'signed-out' };
  }

  async connect(token: unknown): Promise<SlackPostingConnection> {
    if (typeof token !== 'string' || !/^xox[bp]-[a-zA-Z0-9-]{10,2000}$/.test(token)) throw new HttpError(400, t().slackToken);
    if (!this.secrets) throw new HttpError(503, t().slackStorage);
    const op = ++this.operation;
    const { data, scopes } = await this.call('auth.test', token, {});
    if (scopes && !scopes.split(/[,\s]+/).includes('chat:write')) throw new HttpError(400, t().slackScope);
    const { team_id: teamId, user_id: userId, team: workspace, user: sender, url } = data;
    if (![workspace, sender, url, teamId, userId].every((v) => typeof v === 'string' && v.length > 0))
      throw new HttpError(400, t().slackToken);
    const host = URL.canParse(url) ? new URL(url).hostname : '';
    if (!/^[a-z0-9-]+\.slack\.com$/.test(host) || !/^T[A-Z0-9]+$/.test(teamId) || !/^[UW][A-Z0-9]+$/.test(userId))
      throw new HttpError(400, t().slackToken);
    if (op !== this.operation) throw new HttpError(409, t().messageChanged);
    this.secrets.set(
      SECRET,
      JSON.stringify({ revision: randomUUID(), token, teamId, userId, workspace, sender, host } satisfies Credential),
    );
    return this.view();
  }

  disconnect(): SlackPostingConnection {
    this.operation++;
    this.secrets?.delete(SECRET);
    return { status: 'signed-out' };
  }

  private async call(
    method: 'auth.test' | 'conversations.info' | 'chat.postMessage',
    token: string,
    args: Record<string, unknown>,
    revision?: string,
  ) {
    const writing = method === 'chat.postMessage';
    const url = new URL('https://slack.com/api/' + method);
    const readingChannel = method === 'conversations.info';
    if (readingChannel) url.searchParams.set('channel', String(args.channel));
    try {
      const response = await this.fetcher(url, {
        method: readingChannel ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
        ...(readingChannel ? {} : { body: JSON.stringify(args) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const data = JSON.parse(await answerText(response, 128 * 1024, 'Slack'));
      if (data?.ok !== true) {
        const reason: string = data?.error;
        if (reason === 'missing_scope') throw new HttpError(400, t().slackScope);
        if (reason === 'invalid_auth' || reason === 'token_revoked' || reason === 'account_inactive') {
          if (revision && this.saved()?.revision === revision) this.secrets?.delete(SECRET);
          throw new HttpError(400, t().slackToken);
        }
        if (reason === 'channel_not_found' || reason === 'not_in_channel' || reason === 'is_archived')
          throw new HttpError(400, t().slackDestination);
        throw new Error();
      }
      return { data, scopes: response.headers.get('x-oauth-scopes') };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, writing ? t().messageUnknown('Slack') : t().slackCheck);
    }
  }

  async resolvePost(input: string): Promise<SlackPostTarget> {
    const saved = this.saved();
    if (!saved) throw new HttpError(400, t().messageSetup('Slack'));
    const channel = channelId(input, saved);
    const { data } = await this.call('conversations.info', saved.token, { channel }, saved.revision);
    const c = data.channel;
    if (c?.id !== channel || c.is_archived || (!c.name && !c.user)) throw new HttpError(400, t().slackDestination);
    const { revision, teamId, userId, workspace, sender } = saved;
    return { revision, teamId, userId, workspace, sender, channel, destination: c.name ? '#' + c.name : String(c.user) };
  }

  async sendPost(target: SlackPostTarget, text: string): Promise<void> {
    const resolved = await this.resolvePost(target.channel);
    const saved = this.saved();
    if (
      !saved ||
      saved.revision !== target.revision ||
      resolved.revision !== target.revision ||
      resolved.teamId !== target.teamId ||
      resolved.userId !== target.userId ||
      resolved.destination !== target.destination
    )
      throw new HttpError(409, t().messageChanged);
    const { data } = await this.call(
      'chat.postMessage',
      saved.token,
      {
        channel: target.channel,
        text,
        parse: 'none',
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
      },
      saved.revision,
    );
    if (data.channel !== target.channel || typeof data.ts !== 'string') throw new HttpError(502, t().messageUnknown('Slack'));
  }
}
