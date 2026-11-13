import { mkdirSync } from 'node:fs';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send, settled } from '../support/app';
import { cli as factsOf, logged, member, needsFake, withClis } from '../support/clis';
import { installFakeLaunchers, type FakeLaunchers } from '../support/fake-cli';

/*
 * Windows: how Harness Relay finds and starts a CLI that is not a program (`src/server/winLaunch.ts`).
 * Everywhere else the fakes are `.exe` files found on the PATH; here each CLI's executable path is set
 * (Settings, as a user does) to a launcher of the kind it comes with on Windows: Cursor's own
 * (`cursor-agent.cmd`, which runs a Node and a script of Cursor's), npm's shim for a Node script
 * (Cline, Pi), and npm's shim for a program (OpenCode). Through it, Settings asks the CLI's version,
 * and a turn runs (with full access, which every CLI has on Windows).
 */
const LAUNCHED: { provider: keyof FakeLaunchers['bins']; how: string }[] = [
  { provider: 'cursor', how: "Cursor's own launcher" },
  { provider: 'cline', how: "npm's shim for a Node script" },
  { provider: 'pi', how: "npm's shim for a Node script" },
  { provider: 'opencode', how: "npm's shim for a program" },
];

test.describe('CLIs that are scripts on Windows', () => {
  test.skip(process.platform !== 'win32', 'only Windows starts a CLI through a .cmd launcher');
  // Cursor's launcher would put Node's compile cache in the user's own folder (LOCALAPPDATA): the test's instead.
  test.use({
    serverEnv: async ({}, use, testInfo) => {
      const local = testInfo.outputPath('local-app-data');
      mkdirSync(local, { recursive: true });
      await use({ LOCALAPPDATA: local });
    },
  });

  for (const { provider, how } of LAUNCHED) {
    const cli = factsOf(provider);
    test.describe(() => {
      needsFake(provider);
      withClis(provider);

      test(`${provider}: started through ${how}, it is found with its version and answers`, async ({ page, relay, fakeBinDir }) => {
        const launchers = installFakeLaunchers(fakeBinDir);
        await relay.api(`/api/settings/providers/${provider}`, { method: 'PUT', body: { bin: launchers.bins[provider] } });
        await page.goto(`${relay.base}/#/settings/${provider}`);
        const card = page.locator(`#settings-${provider}`);
        await expect(card.locator('.provider-head')).toContainText(cli.version);

        const id = await openTeamChat(page, relay, [member(cli)], { permission: 'full' });
        await send(page, 'Look around e2e:tool');
        await expect(await finishedReply(page, cli.name)).toContainText('You said: “Look around”.');
        await settled(relay, id);
        // The fake ran as the CLI the launcher is for.
        await logged(relay, (e) => e.cli === provider && e.prompt?.includes('Look around'));
      });
    });
  }
});
