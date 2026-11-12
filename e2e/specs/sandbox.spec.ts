import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, replies, send, settled } from '../support/app';
import { CLIS, eachCli, member, needsFake, needsRelaySandbox, OPEN, SIGNED_IN } from '../support/clis';

/*
 * Harness Relay's own sandbox, which the open agents run in below full access (docs/sandboxing.md),
 * and what stands in for one where there is none. The open agents' fakes write and reach hosts for
 * real, so what they may not do is refused by the real sandbox, not by the fake: these run where it
 * works (macOS, and Linux with bubblewrap, socat and ripgrep), and fail instead of skipping when
 * E2E_REQUIRE_RELAY_SANDBOX=1 says it must (CI).
 */
test.describe("Harness Relay's own sandbox", () => {
  // Each open agent that asks before a write in a read-only chat (not Pi, which has no write tool there).
  eachCli(OPEN.filter((c) => c.readOnlyWriteAsks), (cli) => {
    test(`${cli.provider}: in a read-only chat a write the user allows still cannot reach the working directory`, async ({ page, relay }) => {
      needsRelaySandbox(cli.provider);
      await openTeamChat(page, relay, [member(cli)]);
      await send(page, 'Write it e2e:write=out.txt');
      const card = page.getByRole('region', { name: `@${cli.name} wants to change files` });
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      const reply = await finishedReply(page, cli.name);
      await expect(reply.locator('.approval-done')).toContainText('Allowed');
      // Allowed, written for real, and refused by the sandbox (read-only there).
      await expect(reply).toContainText('I may not write out.txt here.');
      await expect(reply.locator('.changes-card')).toHaveCount(0);
      expect(existsSync(join(relay.workDir, 'out.txt'))).toBe(false);
    });
  });

  // A host that is not the run's model backend: the sandbox's proxy asks before it connects (so no
  // name needs to resolve), and refuses when the user declines.
  eachCli(OPEN, (cli) => {
    test(`${cli.provider}: a host the run may not reach is asked about, and refused when declined`, async ({ page, relay }) => {
      needsRelaySandbox(cli.provider);
      const id = await openTeamChat(page, relay, [member(cli)]);
      await send(page, 'Look it up e2e:fetch=http://e2e.example.invalid/');
      const card = page.getByRole('region', { name: `@${cli.name} wants to read a web page` });
      await expect(card.locator('.approval-detail')).toContainText('e2e.example.invalid');
      await card.getByRole('button', { name: 'Decline' }).click();
      const reply = await finishedReply(page, cli.name);
      await expect(reply.locator('.approval-done')).toContainText('Declined');
      await settled(relay, id);
    });
  });
});

/*
 * Where Harness Relay runs an open agent with full access only (on Windows, which its sandbox does
 * not cover yet; OpenCode on Linux, whose server it cannot watch there), a chat below full access
 * does not start it, and says why.
 */
test.describe('below full access where an open agent runs with full access only', () => {
  eachCli(OPEN, (cli) => {
    test.skip(cli.belowFullOn.includes(process.platform), `${cli.label} runs below full access on ${process.platform}`);
    test(`${cli.provider}: its turn does not run, and says why`, async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [member(cli)]);
      await send(page, 'Anyone there?');
      await expect(replies(page, cli.name).last().locator('.msg-error')).toContainText(/only runs with full access|runs only with full access/);
      await settled(relay, id);
      // Its CLI never got the prompt.
      expect(relay.fakeLog().some((e) => e.cli === cli.provider && e.prompt)).toBe(false);
    });
  });
});

test.describe('OpenHands on macOS', () => {
  test.use({ sandboxTerminal: false });
  needsFake('openhands');
  test.skip(process.platform !== 'darwin', 'only macOS needs the switch (Linux gives the sandbox a terminal of its own; Windows runs it with full access only)');

  test('openhands: below full access, it needs its terminal switch', async ({ page, relay }) => {
    const cli = CLIS.find((c) => c.provider === 'openhands')!;
    await openTeamChat(page, relay, [member(cli)]);
    await send(page, 'Anyone there?');
    await expect(replies(page, cli.name).last().locator('.msg-error')).toContainText('Below full access OpenHands runs only with a terminal in the sandbox');
  });
});

/*
 * Antigravity has no sandbox: a project's own setup it would run by itself (its MCP servers, hooks
 * and plugins in `.agents/`) is asked about before agy starts, below full access.
 */
test.describe("a project's own setup", () => {
  needsFake('antigravity');

  test("antigravity: is asked about before agy starts, and a refusal keeps it from starting", async ({ page, relay }) => {
    const cli = SIGNED_IN.find((c) => c.provider === 'antigravity')!;
    mkdirSync(join(relay.workDir, '.agents'), { recursive: true });
    writeFileSync(join(relay.workDir, '.agents', 'mcp_config.json'), '{"mcpServers":{}}\n');
    const id = await openTeamChat(page, relay, [member(cli)]);
    await send(page, 'Anyone there?');
    const card = page.getByRole('region', { name: `@${cli.name} wants to use a tool` });
    await expect(card.locator('.approval-detail')).toContainText(join('.agents', 'mcp_config.json'));
    await card.getByRole('button', { name: 'Decline' }).click();
    await expect(replies(page, cli.name).last().locator('.msg-error')).toContainText('The turn did not start: this project has setup Antigravity would run by itself');
    await settled(relay, id);
    expect(relay.fakeLog().some((e) => e.cli === 'antigravity' && e.prompt)).toBe(false);
  });
});
