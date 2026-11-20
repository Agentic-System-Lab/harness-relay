import { useT } from '../i18n';

// The Install plugin and Add to Claude destinations published in each provider's directory.
const connectors = {
  drive: ['Google Drive', 'b89f7865-a755-4f86-8062-c3bd651740ce', 'plugin_connector_1p_ab21a553bfbc81919ea8fd1858e3ffa7'],
  teams: ['Microsoft Teams', 'ce0c9cda-5ea5-44c5-9cf2-40810dfa6582', 'plugin_connector_1p_eba8b52fe53881918408d4b46b957644'],
  slack: ['Slack', '597f662f-36de-437e-836e-5a81013cbfbe', 'plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d'],
} as const;

export function HostedAppLinks({ app }: { app: keyof typeof connectors }) {
  const a = useT().apps;
  const [name, claude, codex] = connectors[app];
  return (
    <>
      <p className="muted small">{app === 'drive' ? a.hostedDriveRead : a.hostedConsent}</p>
      {app === 'teams' && <p className="muted small">{a.hostedTeamsNote}</p>}
      {app === 'slack' && <p className="muted small">{a.hostedSlackNote}</p>}
      <div className="form-actions hosted-actions">
        <a className="ghost small-button" href={'https://claude.ai/directory/' + claude} target="_blank" rel="noreferrer">
          {a.connectInClaude(name)}
        </a>
        <a className="ghost small-button" href={'https://chatgpt.com/plugins/' + codex} target="_blank" rel="noreferrer">
          {a.connectInCodex(name)}
        </a>
      </div>
    </>
  );
}
