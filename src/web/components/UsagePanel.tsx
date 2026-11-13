import { useEffect, useRef, useState } from 'react';
import type { AccountUsage, Provider } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { usageCredits, usageLevel, usageLimitLabel, usageLine, usageNoneText, usageProblemText } from '../usage';
import { relativeTime } from '../util';

/**
 * How much of an account's plan is used, as its CLI reports it: each limit as a bar with what is left
 * and when it starts over, its credits, or why there is nothing to show (an API key, a CLI that does not
 * report usage). Asked once the box is on screen (each ask starts the CLI) while the account can run
 * (`usable`), again when its sign-in or key changes (`signIn`), and when the user presses Check again;
 * the server keeps an answer for a while. Only the latest ask's answer is shown.
 */
export function UsagePanel({ provider, account, name, usable, signIn }: {
  provider: Provider;
  /** Empty for the default account. */
  account: string;
  /** The account's name, as its box shows it. */
  name: string;
  /** Whether the account can run (signed in, or with an API key): only then is there usage to ask about. */
  usable: boolean;
  /** Changes when the account's sign-in or key does: the usage is asked again. */
  signIn: string;
}) {
  const { t, lang } = useI18n();
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  /** The latest ask: an answer to an earlier one is dropped. */
  const latest = useRef(0);

  // Asked once on screen: Settings shows every CLI's accounts on one page.
  useEffect(() => {
    if (seen || !usable) return;
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [seen, usable]);

  const load = async (refresh: boolean) => {
    const ask = ++latest.current;
    setLoading(true);
    setError('');
    try {
      const u = await api.usage(provider, account, refresh);
      if (ask === latest.current) setUsage(u);
    } catch (e) {
      if (ask === latest.current) setError((e as Error).message);
    } finally {
      if (ask === latest.current) setLoading(false);
    }
  };

  useEffect(() => {
    latest.current++;
    setUsage(null);
    setError('');
    setLoading(false);
    if (usable && seen) void load(false);
    // `load` is the same function for the same provider and account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, account, usable, seen, signIn]);

  // Gone from the page: an answer still on its way is dropped.
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  if (!usable) return null;
  const noneText = usage ? usageNoneText(usage, t) : '';
  const credits = usage ? usageCredits(usage, t, lang) : '';
  const problem = error || (usage ? usageProblemText(usage, t) : '');

  return (
    <div className="usage-panel" ref={box} aria-busy={loading}>
      <div className="usage-head">
        <strong className="small">{t.usage.title}</strong>
        {usage?.plan && <span className="usage-plan muted small">{t.usage.plan(usage.plan)}</span>}
        {usage && !loading && <span className="muted small">{t.usage.checked(relativeTime(usage.checkedAt, t))}</span>}
        <button
          className="ghost small-button"
          onClick={() => void load(true)}
          disabled={loading || !seen}
          aria-label={t.usage.refreshFor(name)}
        >
          {loading ? t.usage.loading : t.usage.refresh}
        </button>
      </div>
      {usage && usage.limits.length > 0 && (
        <ul className="usage-limits">
          {usage.limits.map((l, i) => (
            <li key={i} className={`usage-limit ${usageLevel(l)}`}>
              <span className="usage-label small">{usageLimitLabel(l, t)}</span>
              <span
                className="usage-bar"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(l.usedPercent)}
                aria-label={usageLimitLabel(l, t)}
              >
                <span style={{ width: `${Math.min(100, Math.max(0, l.usedPercent))}%` }} />
              </span>
              <span className="muted small">{usageLine(l, t, lang)}</span>
            </li>
          ))}
        </ul>
      )}
      {credits && <p className="muted small">{credits}</p>}
      {noneText && <p className="muted small">{noneText}</p>}
      {problem && <p className="error-line small">{problem}</p>}
    </div>
  );
}
