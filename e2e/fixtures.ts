/**
 * The tests' fixtures: `relay`, a server of the test's own (`support/relay.ts`), and `page`, a
 * browser page signed in to it, with the guided tour already done and the UI in English.
 *
 * Options (`test.use({ … })`): `lang` ('en' | 'zh-TW'), `signIn` (false: the page is left on no
 * page, signed out), `tour` (true: the guided tour is not marked done) and `serverEnv` (more
 * environment for the server and the CLIs it starts).
 */
import { test as base, expect } from '@playwright/test';
import { installFakeClis } from './support/fake-cli';
import { startRelay, type RelayServer } from './support/relay';

export type Lang = 'en' | 'zh-TW';

interface TestFixtures {
  relay: RelayServer;
  lang: Lang;
  signIn: boolean;
  tour: boolean;
  serverEnv: Record<string, string>;
}

interface WorkerFixtures {
  fakeBinDir: string;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  lang: ['en', { option: true }],
  signIn: [true, { option: true }],
  tour: [false, { option: true }],
  serverEnv: [{}, { option: true }],

  fakeBinDir: [async ({}, use) => use(process.env.E2E_FAKE_BIN_DIR || (await installFakeClis())), { scope: 'worker' }],

  relay: async ({ fakeBinDir, serverEnv }, use, testInfo) => {
    const relay = await startRelay({ fakeBinDir, env: serverEnv });
    try {
      await use(relay);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server.log', { body: relay.output(), contentType: 'text/plain' });
        await testInfo.attach('fake-cli.jsonl', { body: relay.fakeLog().map((e) => JSON.stringify(e)).join('\n'), contentType: 'text/plain' });
      }
      await relay.stop();
    }
  },

  page: async ({ page, relay, lang, signIn, tour }, use) => {
    // Before the app's own scripts: the tour done (unless asked for), the language picked (once:
    // a test may change it, and a reload must keep that).
    await page.addInitScript(
      ({ lang, tour }) => {
        try {
          if (!tour) localStorage.setItem('relay:onboarded', '999');
          if (localStorage.getItem('relay:lang') === null) localStorage.setItem('relay:lang', lang);
        } catch {
          /* storage unavailable */
        }
      },
      { lang, tour },
    );
    if (signIn) {
      await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
      await expect(page.locator('.app main.main')).toBeVisible();
    }
    await use(page);
  },
});

export { expect };
