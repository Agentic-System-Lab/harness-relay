import { useT } from '../i18n';
import { settingsHref } from '../route';

/** Claude owns this account connection. Relay can show what the selected CLI account actually loads. */
export function ClaudeConnectorLink({ app, href }: { app: string; href: string }) {
  const a = useT().apps;
  return (
    <>
      <p className="muted small">{a.claudeAccount}</p>
      <a href={href} target="_blank" rel="noreferrer">
        {a.connectInClaude(app)}
      </a>
      <details className="sub">
        <summary>{a.claudeCheck}</summary>
        <p className="muted small">{a.claudeInspect}</p>
        <a href={settingsHref('claude')}>{a.claudeSettings}</a>
      </details>
    </>
  );
}
