import type { Page } from '@playwright/test';
import { PROVIDER_LABEL, PROVIDERS, type AboutInfo, type ProviderStatus } from '../../src/shared/types';
import { MAILTO_MAX, REPORT_EMAIL } from '../../src/web/report';
import { expect, test } from '../fixtures';
import type { RelayServer } from '../support/relay';

/** What the dialog handed on, kept in the page instead of going anywhere (`catchMail`). */
interface Caught {
  /** The links it opened: the mail app's (`mailto:`) and Gmail's. */
  opened: string[];
  /** What it put on the clipboard. */
  copied: string[];
}

/**
 * Keeps the links the report dialog opens and the text it copies in the page, so that no mail app,
 * no Gmail tab (it would go online) and no system clipboard is reached: Gmail's link goes to
 * `window.open`, the mail app's is a navigation to the `mailto:` link (stopped with the Navigation
 * API), and copying goes to `navigator.clipboard`. Returns what was caught so far.
 */
async function catchMail(page: Page): Promise<() => Promise<Caught>> {
  const supported = await page.evaluate(() => 'navigation' in window);
  test.skip(!supported, 'This browser has no Navigation API to stop the mailto link with');
  await page.evaluate(() => {
    const caught: Caught = { opened: [], copied: [] };
    (window as unknown as { e2eCaught: Caught }).e2eCaught = caught;
    window.open = (url?: string | URL) => {
      caught.opened.push(String(url));
      return null;
    };
    type NavigateEvent = Event & { destination: { url: string } };
    const navigation = (window as unknown as { navigation: EventTarget }).navigation;
    navigation.addEventListener('navigate', (e) => {
      const url = (e as NavigateEvent).destination.url;
      if (!url.startsWith('mailto:')) return;
      caught.opened.push(url);
      e.preventDefault();
    });
    navigator.clipboard.writeText = async (text: string) => {
      caught.copied.push(text);
    };
  });
  return () => page.evaluate(() => (window as unknown as { e2eCaught: Caught }).e2eCaught);
}

/** The version and system lines a report carries, from what the server and the CLIs say. */
async function infoLines(page: Page, relay: RelayServer): Promise<string[]> {
  const about = await relay.api<AboutInfo>('/api/about');
  const clis = await relay.api<ProviderStatus[]>('/api/providers');
  // Every CLI the server knows, in its order: a version, or that it is not installed (Cursor,
  // Antigravity and the open agents, which no fake stands in for).
  const cliLines = PROVIDERS.flatMap((p) => {
    const s = clis.find((x) => x.provider === p);
    return s ? [`${PROVIDER_LABEL[p]}: ${s.installed ? s.version!.trim() : 'not installed'}`] : [];
  });
  expect(cliLines).toEqual(expect.arrayContaining([expect.stringMatching(/^Claude Code: \d/), expect.stringMatching(/^Codex: \d/), expect.stringMatching(/^Grok: \d/)]));
  return [
    `Harness Relay: ${about.version} · web`,
    `OS: ${about.os}`,
    `Node.js: ${about.node}`,
    `Browser: ${await page.evaluate(() => navigator.userAgent)}`,
    ...cliLines,
    'Language: en',
  ];
}

/** A mailto link's address, subject and text (its line breaks CRLF, as RFC 6068 has them). */
function parseMailto(link: string) {
  const url = new URL(link);
  expect(url.protocol).toBe('mailto:');
  return { to: decodeURIComponent(url.pathname), subject: url.searchParams.get('subject'), body: url.searchParams.get('body') ?? '' };
}

/** Gmail's link: its page for writing a mail, with the address, subject and text. */
function parseGmail(link: string) {
  const url = new URL(link);
  expect(url.origin + url.pathname).toBe('https://mail.google.com/mail/');
  expect(url.searchParams.get('view')).toBe('cm');
  return { to: url.searchParams.get('to'), subject: url.searchParams.get('su'), body: url.searchParams.get('body') ?? '' };
}

test.describe('reporting a problem', () => {
  test("the mail's links carry the description and the version and system details", async ({ page, relay }) => {
    const caught = await catchMail(page);
    const info = await infoLines(page, relay);
    await page.getByRole('button', { name: 'Report a problem' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report a problem' });
    const send = dialog.getByRole('button', { name: 'Send', exact: true });
    // Nothing to report yet.
    await expect(send).toBeDisabled();

    // What goes along is shown before it goes: versions and the system, none of the user's paths.
    await dialog.getByText('Version and system details are included').click();
    const details = dialog.locator('.report-info-lines');
    await expect(details).toHaveText(info.join('\n'));
    await expect(details).not.toContainText(relay.root);

    const description = 'The export drops the last row.\nSteps: export a table of three rows.';
    await dialog.getByRole('textbox', { name: 'Details' }).fill(description);
    // The subject left empty: the description's first line stands in.
    const subject = '[Harness Relay] Problem: The export drops the last row.';
    const body = [...description.split('\n'), '', '---', 'Type: Problem', ...info, '', '(Drag screenshots into this mail.)'];

    await send.click();
    await expect(dialog.getByRole('status')).toContainText('Your mail app is open');
    await expect.poll(async () => (await caught()).opened.length).toBe(1);
    const mail = parseMailto((await caught()).opened[0]!);
    expect(mail).toEqual({ to: REPORT_EMAIL, subject, body: body.join('\r\n') });

    await dialog.getByRole('button', { name: 'Send with Gmail' }).click();
    await expect(dialog.getByRole('status')).toContainText('Gmail is open in a new tab');
    await expect.poll(async () => (await caught()).opened.length).toBe(2);
    expect(parseGmail((await caught()).opened[1]!)).toEqual({ to: REPORT_EMAIL, subject, body: body.join('\n') });

    // Copied, the whole mail, to paste into any mail.
    await dialog.getByRole('button', { name: 'Copy report' }).click();
    await expect.poll(async () => (await caught()).copied).toEqual([[`To: ${REPORT_EMAIL}`, `Subject: ${subject}`, '', ...body].join('\n')]);

    // Sent, it is forgotten once the dialog closes.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Report a problem' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Details' })).toHaveValue('');
  });

  test('a report closed before it was sent is kept, and the kind and subject chosen go in the mail', async ({ page }) => {
    const caught = await catchMail(page);
    await page.getByRole('button', { name: 'Report a problem' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report a problem' });
    await dialog.getByRole('button', { name: 'Idea', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Subject' }).fill('Dark mode on a schedule');
    await dialog.getByRole('textbox', { name: 'Details' }).fill('Switch to dark at sunset.');

    // Closed by mistake, nothing is lost.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Report a problem' }).click();
    await expect(dialog.getByRole('button', { name: 'Idea', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('textbox', { name: 'Subject' })).toHaveValue('Dark mode on a schedule');
    await expect(dialog.getByRole('textbox', { name: 'Details' })).toHaveValue('Switch to dark at sunset.');

    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await caught()).opened.length).toBe(1);
    const mail = parseMailto((await caught()).opened[0]!);
    expect(mail.subject).toBe('[Harness Relay] Idea: Dark mode on a schedule');
    expect(mail.body.split('\r\n').slice(0, 4)).toEqual(['Switch to dark at sunset.', '', '---', 'Type: Idea']);
  });

  test('a report too long for the mail link goes on the clipboard, and the mail says to paste it', async ({ page }) => {
    const caught = await catchMail(page);
    await page.getByRole('button', { name: 'Report a problem' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report a problem' });
    const description = `A long log:\n${'line of the log\n'.repeat(200)}`.trim();
    await dialog.getByRole('textbox', { name: 'Details' }).fill(description);
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('it is on the clipboard: paste it into the mail');

    await expect.poll(async () => (await caught()).opened.length).toBe(1);
    const { opened, copied } = await caught();
    expect(opened[0]!.length).toBeLessThanOrEqual(MAILTO_MAX);
    const mail = parseMailto(opened[0]!);
    expect(mail.subject).toBe('[Harness Relay] Problem: A long log:');
    expect(mail.body).toBe('(The report was too long for the link and is on the clipboard: paste it here.)');
    // The whole report is on the clipboard instead.
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain(`To: ${REPORT_EMAIL}\nSubject: [Harness Relay] Problem: A long log:\n\n${description}\n\n---\n`);

    // Gmail's link has room for it.
    await dialog.getByRole('button', { name: 'Send with Gmail' }).click();
    await expect.poll(async () => (await caught()).opened.length).toBe(2);
    expect(parseGmail((await caught()).opened[1]!).body).toContain(description);
  });

  test('screenshots added must be uploaded or removed before the mail can go', async ({ page }) => {
    await page.getByRole('button', { name: 'Report a problem' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report a problem' });
    await dialog.getByRole('textbox', { name: 'Details' }).fill('The button is cut off.');
    const send = dialog.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeEnabled();

    // What is not an image is not taken.
    const picker = dialog.locator('input[type="file"]');
    await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await expect(dialog.getByRole('status')).toContainText('"notes.txt" is not a PNG, JPEG or WebP image');
    await expect(dialog.getByRole('img', { name: 'Screenshot 1' })).toHaveCount(0);

    await picker.setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PNG });
    await expect(dialog.getByRole('img', { name: 'Screenshot 1' })).toBeVisible();
    await expect(dialog.getByText('Upload the screenshots, or remove them, to send.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Upload screenshots' })).toBeEnabled();
    await expect(send).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Send with Gmail' })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Remove screenshot 1' }).click();
    await expect(dialog.getByRole('img', { name: 'Screenshot 1' })).toHaveCount(0);
    await expect(send).toBeEnabled();
  });
});

test.describe('reporting a problem without GitHub', () => {
  // Screenshots go up through the user's gh, here the fake one, signed out.
  test.use({ serverEnv: { E2E_FAKE_SIGNED_OUT: 'gh' } });

  test('screenshots that cannot be uploaded say why, and the report goes without them', async ({ page, relay }) => {
    await page.getByRole('button', { name: 'Report a problem' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report a problem' });
    await dialog.getByRole('textbox', { name: 'Details' }).fill('The button is cut off.');
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PNG });
    await dialog.getByRole('button', { name: 'Upload screenshots' }).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('GitHub CLI (gh) is not signed in. Run gh auth login in a terminal, then try again.');
    await expect(alert).toContainText('Or remove the screenshots, and drag them into the mail once it opens.');
    expect(relay.fakeLog().some((e) => e.cli === 'gh')).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Remove screenshot 1' }).click();
    await expect(alert).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  });
});

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
