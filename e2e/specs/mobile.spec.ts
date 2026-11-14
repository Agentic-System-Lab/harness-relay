import { devices } from '@playwright/test';
import { SCHEDULE_KINDS } from '../../src/shared/types';
import { en } from '../../src/web/locales/en';
import { zhTW } from '../../src/web/locales/zh-TW';
import { expect, test } from '../fixtures';
import { composer, finishedReply, homePage, openTeamChat } from '../support/app';

// A phone's screen, the way the chat is used over Tailscale (docs/remote-access.md).
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];

test.describe('on a phone', () => {
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  // Firefox has no mobile emulation.
  test.skip(({ browserName }) => browserName === 'firefox', 'no mobile emulation in Firefox');

  test('the sidebar opens from the menu, and a chat works by touch', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'On the go');
    // The sidebar is tucked away until the menu opens it.
    await expect(page.locator('.sidebar')).not.toBeInViewport();
    // The menu's three lines sit in the middle of its button (an icon, not a text glyph on a baseline; no
    // padding, which WebKit's default puts 1px more of below than above).
    const menu = page.getByRole('button', { name: 'Open sidebar' });
    const [box, icon] = [(await menu.boundingBox())!, (await menu.locator('svg').boundingBox())!];
    expect(Math.abs(icon.x + icon.width / 2 - (box.x + box.width / 2))).toBeLessThanOrEqual(0.1);
    expect(Math.abs(icon.y + icon.height / 2 - (box.y + box.height / 2))).toBeLessThanOrEqual(0.1);
    await menu.tap();
    await expect(page.locator('.conv-link', { hasText: 'On the go' })).toBeInViewport();
    // Going somewhere closes it again.
    await page.getByRole('button', { name: 'New chat' }).first().tap();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await expect(page.locator('.sidebar')).not.toBeInViewport();
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    await page.locator('.conv-link', { hasText: 'On the go' }).tap();
    await expect(page.locator('.sidebar')).not.toBeInViewport();

    await expect(composer(page)).toBeVisible();
    await composer(page).fill('Quick question');
    // On a touch screen Enter is a new line: the send button sends.
    await page.getByRole('button', { name: 'Send' }).tap();
    await expect(page.locator('.msg-user', { hasText: 'Quick question' })).toBeVisible();
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Quick question”.');

    // The header's actions are under ⋯.
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).tap();
    await expect(page.getByRole('dialog', { name: 'Files' })).toBeVisible();
  });

  test('a long message keeps the page from scrolling sideways', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await composer(page).fill(`A very long word: ${'x'.repeat(300)} e2e:markdown`);
    await page.getByRole('button', { name: 'Send' }).tap();
    await finishedReply(page, 'Claude');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("on a narrow phone, a template's editor and the team settings do not scroll sideways, and the add card lists every CLI", async ({ page, relay }) => {
    /** How far a scrolling box scrolls sideways. */
    const sideways = (box: string) => page.locator(box).evaluate((el) => el.scrollWidth - el.clientWidth);
    // 320px: an iPhone SE (1st generation), or a mini with Display Zoom, narrower than a 290px member card
    // and its margins; 280px: a foldable's cover screen, where English's "hand-offs / message" goes on a
    // line of its own.
    const widths = [320, 280];
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    await page.getByRole('button', { name: 'New chat' }).first().tap();
    // A relay template: its rules have the hand-off limit, a number box with its unit.
    await page.locator('.preset-card', { hasText: 'Architect → Builder → Reviewer' }).locator('.preset-main').tap();
    const editor = page.getByRole('dialog');
    await expect(editor.locator('input[value="Architect"]')).toBeVisible();
    await expect(editor.getByText('hand-offs / message')).toBeAttached();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 640 });
      expect(await sideways('.template-editor-body')).toBeLessThanOrEqual(1);
      // One column: the add card shares no row, so it lists every CLI without a scroll of its own.
      expect(await editor.locator('.add-card-list').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press('Escape');

    await page.setViewportSize(viewport);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { mode: 'relay' });
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).tap();
    await expect(page.getByRole('dialog', { name: 'Team settings' }).locator('input[value="Claude"]')).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 640 });
      expect(await sideways('.drawer')).toBeLessThanOrEqual(1);
      expect(await page.locator('.drawer .add-card-list').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    }
  });

  test('on a narrow phone, a new schedule of any kind does not scroll sideways, in either language, nor does a chat\'s Schedule', async ({ page, relay }) => {
    /** The boxes that scroll sideways, and how far. */
    const sideways = () =>
      page.evaluate(() =>
        [document.documentElement, ...document.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1 && (el === document.documentElement || ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)))
          .map((el) => `${el.className || el.tagName} +${el.scrollWidth - el.clientWidth}`),
      );
    /** How many rows the buttons in `box` take. */
    const rows = (box: string) =>
      page.locator(box).evaluate((g) => new Set([...g.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))).size);
    // The four kinds of schedule go two by two in English below a 380px column (they need about 340px
    // on one row, more with a wider font): at 400px (368px) too, not at 430px (398px). In Chinese they
    // need about 222px: at 250px (a 218px column) they go two by two. The week's seven days need about
    // 310px in English and 276px in Chinese: below that they go onto two rows.
    const widths = [320, 280];
    const widthsOf = { en: [...widths, 400, 430], 'zh-TW': [...widths, 250] };
    const kindRows = (lang: 'en' | 'zh-TW', width: number) => (lang === 'en' ? (width <= 400 ? 2 : 1) : width <= 250 ? 2 : 1);
    const dayRows = (lang: 'en' | 'zh-TW', width: number) => (lang === 'en' ? (width <= 320 ? 2 : 1) : width <= 280 ? 2 : 1);
    for (const [lang, messages] of [['en', en], ['zh-TW', zhTW]] as const) {
      const s = messages.schedule;
      await page.evaluate((l) => localStorage.setItem('relay:lang', l), lang);
      await page.setViewportSize(viewport);
      await page.goto(`${relay.base}/#/schedule`);
      // Only the hash changes from one language to the next: load the page again in the new one.
      await page.reload();
      for (const kind of SCHEDULE_KINDS) {
        await page.setViewportSize(viewport);
        await page.getByRole('radiogroup', { name: s.repeat }).getByRole('radio', { name: s.kinds[kind], exact: true }).tap();
        if (kind === 'interval') {
          // The interval's unit is only "hours", next to its box; its hint, a line of its own, still describes the box.
          await expect(page.locator('.schedule-form .field.inline .unit')).toHaveText(s.hoursUnit);
          await expect(page.locator('.schedule-form input[type="number"]')).toHaveAccessibleDescription(s.intervalHint);
        }
        for (const width of widthsOf[lang]) {
          await page.setViewportSize({ width, height: 640 });
          expect(await sideways(), `${lang}, ${kind}, ${width}px`).toEqual([]);
          expect(await rows('.schedule-repeat [role="radiogroup"]'), `the kinds, ${lang}, ${width}px`).toBe(kindRows(lang, width));
          if (kind === 'weekly') expect(await rows('.day-picker'), `the days, ${lang}, ${width}px`).toBe(dayRows(lang, width));
        }
      }
    }

    // A chat's Schedule drawer, with the week's days.
    await page.evaluate(() => localStorage.setItem('relay:lang', 'en'));
    await page.setViewportSize(viewport);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    // Only the hash changed: load the chat again in English.
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await page.getByRole('button', { name: 'More' }).tap();
    await page.locator('.chat-head').getByRole('button', { name: 'Schedule' }).tap();
    const drawer = page.getByRole('dialog', { name: 'Schedule' });
    await drawer.getByRole('radiogroup', { name: 'When' }).getByRole('radio', { name: 'Every week', exact: true }).tap();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 640 });
      expect(await sideways(), `the drawer, ${width}px`).toEqual([]);
    }
  });

  test("the home page's tagline is smaller, each of its lines on one line, and the logo closes the sidebar", async ({ page }) => {
    /** The tagline's size, how many lines it takes, and whether the page scrolls sideways. */
    const tagline = () =>
      page.locator('.home-line').evaluate((h) => {
        const style = getComputedStyle(h);
        return {
          size: parseFloat(style.fontSize),
          lines: Math.round(h.getBoundingClientRect().height / parseFloat(style.lineHeight)),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
    await expect(homePage(page)).toBeVisible();
    // English on two lines ("From now on," and the rest), neither of them wrapped.
    expect(await tagline()).toEqual({ size: expect.any(Number), lines: 2, overflow: expect.any(Number) });
    const en = await tagline();
    expect(en.size).toBeLessThan(22);
    expect(en.overflow).toBeLessThanOrEqual(1);

    // Tapping the logo closes the sidebar, also when the home page is open already.
    await page.getByRole('button', { name: 'Open sidebar' }).tap();
    await expect(page.locator('.sidebar')).toBeInViewport();
    await page.locator('.sidebar').getByRole('link', { name: 'Harness Relay', exact: true }).tap();
    await expect(page.locator('.sidebar')).not.toBeInViewport();

    // Chinese on one line.
    await page.evaluate(() => localStorage.setItem('relay:lang', 'zh-TW'));
    await page.reload();
    await expect(page.getByRole('heading', { name: '讓你的 agent 團隊從此為你幹活' })).toBeVisible();
    const zh = await tagline();
    expect(zh.lines).toBe(1);
    expect(zh.size).toBeLessThan(22);
    expect(zh.overflow).toBeLessThanOrEqual(1);
  });
});

