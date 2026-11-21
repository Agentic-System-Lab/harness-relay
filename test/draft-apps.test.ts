import { expect, it } from 'vitest';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import { canConfirmSelectedApp, requestedApps, taskWithApps, unavailableSelectedApps } from '../src/web/draftApps';

it('lets an expired Slack selection reach its explicit check, and requires positive availability for other selections', () => {
  expect(canConfirmSelectedApp('slack', 'needs-verification')).toBe(true);
  expect(canConfirmSelectedApp('slack', 'needs-connection')).toBe(false);
  expect(canConfirmSelectedApp('slack')).toBe(false);
  expect(canConfirmSelectedApp('teams', 'needs-verification')).toBe(false);
  expect(canConfirmSelectedApp('teams', 'ready')).toBe(true);
  expect(
    unavailableSelectedApps(['drive', 'slack', 'teams', 'mail'], {
      slack: 'needs-verification',
      teams: 'needs-assistant',
      mail: 'ready',
    }),
  ).toEqual(['teams']);
});

it('sends exactly the request displayed in either language, only when the task and selected list are nonempty', () => {
  for (const messages of [en, zhTW]) {
    const line = messages.apps.requestApps(['Notion', 'Heptabase', messages.tools.relay.groups.drive]);
    expect(requestedApps(['notion', 'heptabase', 'drive'], messages)).toBe(line);
    expect(taskWithApps('  Review  ', ['notion', 'heptabase', 'drive'], messages)).toBe('Review\n\n' + line);
    expect(taskWithApps('  Review  ', [], messages)).toBe('Review');
    expect(taskWithApps(' ', ['drive'], messages)).toBe('');
  }
});
