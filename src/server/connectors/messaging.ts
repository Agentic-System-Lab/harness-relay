import type { OutboxPreview } from '../../shared/types';
import type { GatewayTool } from '../gateway';
import { t } from '../i18n';
import type { SlackPosting, SlackPostTarget } from './slack';
import type { TeamsGraph, TeamsPostTarget } from './teams';

function messageTool<Target>(
  group: 'teams' | 'slack',
  app: string,
  sender: { resolvePost(link: string): Promise<Target>; sendPost(target: Target, text: string): Promise<void> },
  describeTarget: (target: Target) => OutboxPreview['fields'],
  destination: string,
): GatewayTool {
  return {
    group,
    name: group + '_send_message',
    tier: 'send',
    description:
      'Propose a new plain-text message in ' +
      app +
      '. The user reviews the sender, destination and complete message in Relay before sending. A copied message link identifies the conversation; this is not a thread reply.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: destination },
        text: { type: 'string', description: 'Complete plain-text message.' },
      },
      required: ['destination', 'text'],
      additionalProperties: false,
    },
    describe: () => ({ title: t().messageTitle(app) }),
    async prepare(args) {
      const { text, destination } = args;
      if (typeof destination !== 'string' || !destination || destination.length > 8192) throw new Error(t().invalidField('destination'));
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        Buffer.from(text).toString('utf8') !== text ||
        /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text) ||
        (group === 'slack' ? [...text].length > 3000 : Buffer.byteLength(text) > 28 * 1024)
      )
        throw new Error(t().invalidField('text'));
      const target = await sender.resolvePost(destination);
      return { title: t().messageTitle(app), preview: { fields: describeTarget(target), body: text }, args: { target, text } };
    },
    async send(args, item) {
      if (!args.target || typeof args.text !== 'string' || args.text !== item.preview.body) throw new Error(t().messageChanged);
      await sender.sendPost(args.target as Target, args.text);
      return t().messageSent(app);
    },
  };
}

export function messagingTools(
  slack: Pick<SlackPosting, 'resolvePost' | 'sendPost'>,
  teams: Pick<TeamsGraph, 'resolvePost' | 'sendPost'>,
): GatewayTool[] {
  const f = (label: string, value: string) => ({ label, value });
  return [
    messageTool<SlackPostTarget>(
      'slack',
      'Slack',
      slack,
      (s) => [
        f(t().messageFrom, s.sender + ' · ' + s.userId),
        f(t().messageWorkspace, s.workspace + ' · ' + s.teamId),
        f(t().messageTo, s.destination + ' · ' + s.channel),
      ],
      'Slack conversation ID or a copied Slack channel or message link in the authorized workspace.',
    ),
    messageTool<TeamsPostTarget>(
      'teams',
      'Microsoft Teams',
      teams,
      (s) => [
        f(t().messageFrom, s.sender),
        f(t().messageTenant, s.tenantId),
        f(s.kind === 'channel' ? t().messageNewPost : t().messageChat, s.destination + ' · ' + s.destinationId),
      ],
      'Official Teams link for an existing channel, chat or message.',
    ),
  ];
}
