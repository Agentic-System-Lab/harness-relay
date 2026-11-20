import { useState, type ReactNode } from 'react';
import { APP_SERVERS } from '../../shared/apps';
import type { SlackPostingConnection, ToolLibraryView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { HostedAppRow, type HostedAccounts } from './HostedAppLinks';
import { AppSignIn } from './McpSignIn';
import { SlackPostingSettings } from './SlackPostingSettings';

export function SlackAppRow({
  lib,
  accounts,
  active,
  access,
  change,
}: {
  active: boolean;
  lib: ToolLibraryView;
  accounts: HostedAccounts;
  access: ReactNode;
  change: (call: () => Promise<ToolLibraryView>) => Promise<boolean>;
}) {
  const t = useT();
  const a = t.apps;
  const [posting, setPosting] = useState<SlackPostingConnection>();
  const servers = lib.mcpServers.filter((s) => s.app === 'slack' || (s.transport === 'http' && s.url === APP_SERVERS.slack));
  const saved = servers.filter((s) => s.oauth);
  const direct =
    posting?.status === 'connected'
      ? [posting.sender, posting.workspace, a.postingEnabled].join(' · ')
      : saved.length
        ? saved.some((s) => s.oauth?.status === 'reauth')
          ? t.connectors.oauth.reauth
          : a.savedSlack
        : '';
  return (
    <HostedAppRow active={active} app="slack" accounts={accounts} directStatus={direct}>
      <SlackPostingSettings view={posting} setView={setPosting} access={access} />
      {servers.map((server) => (
        <div key={server.id}>
          {server.oauth && <p className="small">{a.slackExisting(server.name)}</p>}
          <AppSignIn
            name="Slack"
            oauth={server.oauth}
            startRequest={server.oauth ? () => api.startMcpSignIn(server.name) : undefined}
            onDone={() => change(() => api.tools())}
            onSignOut={() => change(() => api.signOutMcp(server.name))}
          />
        </div>
      ))}
    </HostedAppRow>
  );
}
