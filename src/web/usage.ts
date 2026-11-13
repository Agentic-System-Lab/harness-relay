import { PROVIDER_LABEL, type AccountUsage, type Lang, type UsageLimit } from '../shared/types';
import type { Messages } from './locales/zh-TW';

/*
 * How Settings shows an account's plan usage (`components/UsagePanel.tsx`): each limit's name, what is
 * left of it, how full it is, and when it starts over. Pure, for tests.
 */

/**
 * What a limit is called: its span ("Weekly limit"), and what it counts or is for when not the whole
 * plan ("Premium requests", "Fable").
 */
export function usageLimitLabel(l: UsageLimit, t: Messages): string {
  const span = l.span ? t.usage.span[l.span] : l.minutes ? t.usage.minutes(l.minutes) : t.usage.allowance;
  const what = l.kind ? t.usage.kind[l.kind] : l.scope;
  return what ? `${span} · ${what}` : span;
}

/** How much of a limit is left, in whole percent (0–100). */
export function usageLeft(l: UsageLimit): number {
  return Math.max(0, Math.min(100, Math.round(100 - l.usedPercent)));
}

/** How close a limit is to running out: the bar's colour. */
export function usageLevel(l: UsageLimit): 'ok' | 'warn' | 'out' {
  if (l.usedPercent >= 100) return 'out';
  return l.usedPercent >= 80 ? 'warn' : 'ok';
}

/** The locale `Intl` formats in for the UI's language. */
const locale = (lang: Lang) => (lang === 'zh-TW' ? 'zh-TW' : 'en-US');

/**
 * When a limit starts over: in minutes or hours when that is within a day ("resets in 3 h"), else its
 * date and time in the UI's language ("resets Nov 17, 13:30"). Empty for a time already past.
 */
export function usageResets(at: number | undefined, t: Messages, lang: Lang, now = Date.now()): string {
  if (!at || at <= now) return '';
  const d = at - now;
  if (d < 3_600_000) return t.usage.resetsIn(t.usage.inMinutes(Math.max(1, Math.ceil(d / 60_000))));
  if (d < 86_400_000) return t.usage.resetsIn(t.usage.inHours(Math.round(d / 3_600_000)));
  const date = new Date(at).toLocaleString(locale(lang), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return t.usage.resetsAt(date);
}

/** One limit's line beside its bar: what is left, what is used (or the requests used), and when it resets. */
export function usageLine(l: UsageLimit, t: Messages, lang: Lang, now = Date.now()): string {
  const used =
    l.used !== undefined && l.total !== undefined
      ? t.usage.requests(l.used.toLocaleString(locale(lang)), l.total.toLocaleString(locale(lang)))
      : t.usage.used(Math.round(l.usedPercent));
  return [t.usage.left(usageLeft(l)), used, usageResets(l.resetsAt, t, lang, now)].filter(Boolean).join(' · ');
}

/** The credits line (Codex's), or empty when the account has none. */
export function usageCredits(u: Pick<AccountUsage, 'credits'>, t: Messages, lang: Lang): string {
  if (!u.credits) return '';
  if (u.credits.unlimited) return t.usage.creditsUnlimited;
  if (u.credits.balance === undefined) return '';
  return t.usage.credits(u.credits.balance.toLocaleString(locale(lang), { maximumFractionDigits: 2 }));
}

/** Why an account shows no limits, in the UI's words; empty when it has some (or an error says why). */
export function usageNoneText(u: Pick<AccountUsage, 'provider' | 'none' | 'limits' | 'error' | 'problem'>, t: Messages): string {
  if (u.error || u.problem || !u.none) return '';
  if (u.none === 'notReported') return t.usage.notReported[u.provider as keyof Messages['usage']['notReported']] ?? t.usage.notReported.other;
  return t.usage.none[u.none];
}

/** What went wrong asking the CLI: its own words, else Harness Relay's (`problem`) in the UI's language; empty when nothing did. */
export function usageProblemText(u: Pick<AccountUsage, 'provider' | 'error' | 'problem'>, t: Messages): string {
  if (u.error) return u.error;
  if (u.problem === 'cliMissing') return t.usage.problem.cliMissing(PROVIDER_LABEL[u.provider]);
  return u.problem ? t.usage.problem[u.problem] : '';
}
