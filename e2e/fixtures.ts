/**
 * The tests' fixtures: `relay`, a server of the test's own (`support/relay.ts`), and `page`, a
 * browser page signed in to it, with the guided tour already done and the UI in English.
 *
 * Options (`test.use({ … })`): `lang` ('en' | 'zh-TW'), `signIn` (false: the page is left on no
 * page, signed out), `tour` (true: the guided tour is not marked done), `envNotice` (true: New chat
 * may say which keys of the server's environment a CLI is not given), `serverEnv` (more
 * environment for the server and the CLIs it starts), `live` (the real CLIs: `e2e/live/`),
 * `missingClis` (the CLIs not installed: by default all but Claude Code, Codex and Grok,
 * `DEFAULT_CLIS`; `withClis()` and the per-CLI helpers of `support/clis.ts` set it),
 * `openBackend` (false: no model backend, so the open agents are installed but not ready) and
 * `sandboxTerminal` (false: OpenHands' terminal switch off).
 */
import { test as base, expect } from '@playwright/test';
import type { Provider } from '../src/shared/types';
import { installFakeClis, notInstalledBut } from './support/fake-cli';
import { startRelay, type RelayServer } from './support/relay';

export type Lang = 'en' | 'zh-TW';

interface TestFixtures {
  relay: RelayServer;
  lang: Lang;
  signIn: boolean;
  tour: boolean;
  /** Whether New chat may ask to install what the sandboxes lack (`src/web/sandboxSetup.ts`); answered already otherwise. */
  sandboxAsk: boolean;
  /** Whether New chat may say, once, which keys of the server's environment a CLI is not given (`src/web/agentEnv.ts`); seen already otherwise. */
  envNotice: boolean;
  serverEnv: Record<string, string>;
  /** The real CLIs as the user signed them in, on real models (`e2e/live/`, `startRelay`'s `live`). */
  live: boolean;
  /** The CLIs not installed in the test's server (`startRelay`'s `missingClis`). */
  missingClis: readonly Provider[];
  /** Whether the fake endpoint is the open agents' model backend (`startRelay`'s `openBackend`). */
  openBackend: boolean;
  /** Whether OpenHands may use a terminal in Harness Relay's own sandbox (`startRelay`'s `sandboxTerminal`). */
  sandboxTerminal: boolean;
}

interface WorkerFixtures {
  fakeBinDir: string;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  lang: ['en', { option: true }],
  signIn: [true, { option: true }],
  tour: [false, { option: true }],
  sandboxAsk: [false, { option: true }],
  envNotice: [false, { option: true }],
  serverEnv: [{}, { option: true }],
  live: [false, { option: true }],
  missingClis: [notInstalledBut(), { option: true }],
  openBackend: [true, { option: true }],
  sandboxTerminal: [true, { option: true }],

  fakeBinDir: [async ({}, use) => use(process.env.E2E_FAKE_BIN_DIR || (await installFakeClis())), { scope: 'worker' }],

  relay: async ({ fakeBinDir, serverEnv, live, missingClis, openBackend, sandboxTerminal }, use, testInfo) => {
    const relay = await startRelay({ fakeBinDir, env: serverEnv, live, missingClis, openBackend, sandboxTerminal });
    try {
      await use(relay);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server.log', { body: relay.output(), contentType: 'text/plain' });
        await testInfo.attach('fake-cli.jsonl', {
          body: relay
            .fakeLog()
            .map((e) => JSON.stringify(e))
            .join('\n'),
          contentType: 'text/plain',
        });
      }
      await relay.stop();
    }
  },

  page: async ({ page, relay, lang, signIn, tour, sandboxAsk, envNotice }, use) => {
    // Before the app's own scripts: the tour done (unless asked for), the sandboxes' setup answered
    // (unless asked for: New chat would ask on a computer whose sandboxes lack something), the notice
    // of the keys a CLI is not given seen (unless asked for: a spec's `serverEnv` may hold one), the
    // language picked (once: a test may change it, and a reload must keep that).
    await page.addInitScript(
      ({ lang, tour, sandboxAsk, envNotice }) => {
        try {
          if (!tour) localStorage.setItem('relay:onboarded', '999');
          if (!sandboxAsk) localStorage.setItem('relay:sandbox-setup-asked', '1');
          if (!envNotice) localStorage.setItem('relay:withheld-env-seen', '1');
          if (localStorage.getItem('relay:lang') === null) localStorage.setItem('relay:lang', lang);
        } catch {
          /* storage unavailable */
        }
      },
      { lang, tour, sandboxAsk, envNotice },
    );
    if (signIn) {
      await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
      await expect(page.locator('.app main.main')).toBeVisible();
    }
    await use(page);
  },
});

export { expect };
