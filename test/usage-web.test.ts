import { describe, expect, it } from 'vitest';
import type { AccountUsage, UsageLimit } from '../src/shared/types';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import { usageCredits, usageLeft, usageLevel, usageLimitLabel, usageLine, usageNoneText, usageProblemText, usageResets } from '../src/web/usage';

/* How Settings shows an account's plan usage (`src/web/usage.ts`, for `components/UsagePanel.tsx`). */

const now = Date.parse('2026-11-13T12:00:00Z');

describe("a limit's name", () => {
  it('is its span, with what it is for when not the whole plan', () => {
    expect(usageLimitLabel({ span: 'week', usedPercent: 0 }, en)).toBe('Weekly limit');
    expect(usageLimitLabel({ span: 'week', scope: 'Fable', usedPercent: 0 }, en)).toBe('Weekly limit · Fable');
    expect(usageLimitLabel({ span: 'fiveHour', usedPercent: 0 }, zhTW)).toBe('5 小時額度');
  });

  it('names what a limit counts when the UI knows it (Copilot\'s premium requests), in either language', () => {
    expect(usageLimitLabel({ span: 'month', kind: 'premiumRequests', usedPercent: 0 }, en)).toBe('Monthly limit · Premium requests');
    expect(usageLimitLabel({ span: 'month', kind: 'completions', usedPercent: 0 }, zhTW)).toBe('每月額度 · 程式碼補全');
  });

  it('is its length when it is none of the usual spans, and the allowance when the CLI gives neither', () => {
    expect(usageLimitLabel({ minutes: 120, usedPercent: 0 }, en)).toBe('2-hour limit');
    expect(usageLimitLabel({ minutes: 2880, usedPercent: 0 }, zhTW)).toBe('2 天額度');
    expect(usageLimitLabel({ minutes: 45, usedPercent: 0 }, en)).toBe('45-minute limit');
    expect(usageLimitLabel({ usedPercent: 0 }, en)).toBe('Allowance');
  });
});

describe('what is left of a limit', () => {
  it('is the rest of 100, in whole percent, never below 0', () => {
    expect([12.4, 55, 100, 130, -5].map((usedPercent) => usageLeft({ usedPercent }))).toEqual([88, 45, 0, 0, 100]);
  });

  it('colours the bar as it fills', () => {
    expect([0, 79.9, 80, 99, 100].map((usedPercent) => usageLevel({ usedPercent }))).toEqual(['ok', 'ok', 'warn', 'warn', 'out']);
  });
});

describe('when a limit starts over', () => {
  it('is in minutes or hours within a day, else its date and time, and nothing once past', () => {
    expect(usageResets(now + 10 * 60_000, en, 'en', now)).toBe('resets in 10 min');
    expect(usageResets(now + 5 * 3_600_000 + 60_000, en, 'en', now)).toBe('resets in 5 h');
    expect(usageResets(now + 20_000, zhTW, 'zh-TW', now)).toBe('1 分鐘後重置');
    // In whatever timezone the tests run in.
    const later = now + 4 * 86_400_000;
    const shown = new Date(later).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    expect(usageResets(later, en, 'en', now)).toBe(`resets ${shown}`);
    expect(shown).toMatch(/^Nov 1[678], /);
    expect(usageResets(now - 1, en, 'en', now)).toBe('');
    expect(usageResets(undefined, en, 'en', now)).toBe('');
  });
});

describe("a limit's line", () => {
  it('says what is left, what is used and when it resets', () => {
    const l: UsageLimit = { span: 'week', usedPercent: 55, resetsAt: now + 2 * 3_600_000 };
    expect(usageLine(l, en, 'en', now)).toBe('45% left · 55% used · resets in 2 h');
    expect(usageLine(l, zhTW, 'zh-TW', now)).toBe('剩 45% · 已用 55% · 2 小時後重置');
  });

  it('counts requests for a limit of requests', () => {
    expect(usageLine({ usedPercent: 40, used: 120, total: 300 }, en, 'en', now)).toBe('60% left · 120 of 300 requests used');
  });
});

describe('the credits and why there are no limits', () => {
  const usage = (u: Partial<AccountUsage>): AccountUsage => ({ provider: 'claude', account: '', limits: [], checkedAt: now, ...u });

  it('gives the credits left, or unlimited, and nothing without credits', () => {
    expect(usageCredits(usage({ credits: { balance: 52831.177348 } }), en, 'en')).toBe('Credits left: 52,831.18');
    expect(usageCredits(usage({ credits: { unlimited: true } }), zhTW, 'zh-TW')).toBe('點數：無上限');
    expect(usageCredits(usage({}), en, 'en')).toBe('');
  });

  it('says why, by CLI when the CLI does not report usage, and nothing when an error says why', () => {
    expect(usageNoneText(usage({ none: 'apiKey' }), en)).toMatch(/^This account runs on an API key/);
    expect(usageNoneText(usage({ provider: 'cursor', none: 'notReported' }), en)).toMatch(/^Cursor's CLI shows usage only in its own terminal UI/);
    expect(usageNoneText(usage({ provider: 'opencode', none: 'notReported' }), en)).toBe('This CLI does not report plan usage.');
    expect(usageNoneText(usage({ provider: 'copilot', none: 'unlimited' }), en)).toBe("This account's plan has no usage limits.");
    expect(usageNoneText(usage({ none: 'noData', error: 'boom' }), en)).toBe('');
    expect(usageNoneText(usage({ limits: [{ usedPercent: 3 }] }), en)).toBe('');
  });

  it("says Claude Code reports no limits for how the account signs in, and nothing beside an error or Harness Relay's own problem", () => {
    expect(usageNoneText(usage({ none: 'unavailable' }), en)).toMatch(/^The CLI reports no plan limits for how this account signs in/);
    expect(usageNoneText(usage({ none: 'noData', problem: 'timedOut' }), en)).toBe('');
  });

  it("words what went wrong: the CLI's own words as they are, Harness Relay's in the UI's language", () => {
    expect(usageProblemText(usage({ error: 'Unsupported control request subtype: get_usage' }), zhTW)).toBe('Unsupported control request subtype: get_usage');
    expect(usageProblemText(usage({ problem: 'timedOut' }), en)).toBe('The CLI did not answer in time.');
    expect(usageProblemText(usage({ provider: 'codex', problem: 'cliMissing' }), zhTW)).toBe('找不到 Codex 的 CLI。');
    expect(usageProblemText(usage({ provider: 'codex', problem: 'cliMissing' }), en)).toBe("Codex's CLI was not found.");
    expect(usageProblemText(usage({}), en)).toBe('');
  });
});
