import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, send } from '../support/app';

const CLIS = [
  { name: 'Claude', provider: 'claude' },
  { name: 'Codex', provider: 'codex' },
  { name: 'Grok', provider: 'grok' },
] as const;

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.describe('what reaches each CLI besides the prompt', () => {
  for (const cli of CLIS) {
    test(`${cli.provider}: an MCP server from the tool library, with its secret kept off the command line`, async ({ page, relay }) => {
      await relay.api('/api/tools/mcp/e2e-tools', {
        method: 'PUT',
        body: { transport: 'stdio', command: 'e2e-mcp-server', args: ['--serve'], env: [{ name: 'E2E_TOKEN', value: 's3cr3t-e2e-token' }] },
      });
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }]);
      await send(page, 'Which tools do you have?');
      await expect(await finishedReply(page, cli.name)).toContainText("My tool library's MCP servers: e2e-tools.");
      const starts = relay.fakeLog().filter((e) => e.cli === cli.provider && e.args);
      expect(starts.length).toBeGreaterThan(0);
      for (const s of starts) expect(JSON.stringify(s.args)).not.toContain('s3cr3t-e2e-token');
    });

    test(`${cli.provider}: an attached image`, async ({ page, relay }) => {
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }]);
      await page.locator('.composer input[type="file"], .composer-row input[type="file"]').first().setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG });
      await expect(page.getByRole('button', { name: 'Remove dot.png' })).toBeVisible();
      await composer(page).fill('What is in the picture?');
      await composer(page).press('Enter');
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('You said: “What is in the picture?”. I got 1 image.');
      // The prompt names the file too, for the agent's own file tools.
      expect(relay.fakeLog().some((e) => e.cli === cli.provider && e.prompt?.includes('dot.png (image/png'))).toBe(true);
    });
  }
});
