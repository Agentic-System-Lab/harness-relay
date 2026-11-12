import { expect, test } from '../fixtures';
import { composer, finishedReply, send, settled } from '../support/app';
import { chatWith, CLIS, eachCli, logged } from '../support/clis';

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.describe('what reaches each CLI besides the prompt', () => {
  eachCli(CLIS, (cli) => {
    test(`${cli.provider}: an MCP server from the tool library, with its secret kept off the command line`, async ({ page, relay }) => {
      await relay.api('/api/tools/mcp/e2e-tools', {
        method: 'PUT',
        body: { transport: 'stdio', command: 'e2e-mcp-server', args: ['--serve'], env: [{ name: 'E2E_TOKEN', value: 's3cr3t-e2e-token' }] },
      });
      const id = await chatWith(page, relay, cli);
      await send(page, 'Which tools do you have?');
      await expect(await finishedReply(page, cli.name)).toContainText("My tool library's MCP servers: e2e-tools.");
      await settled(relay, id);
      const starts = await logged(relay, (e) => e.cli === cli.provider && e.args);
      for (const s of starts) expect(JSON.stringify(s.args)).not.toContain('s3cr3t-e2e-token');
    });
  });

  // The CLIs whose adapter gives them HTTP servers (`mcpHttp`).
  eachCli(CLIS.filter((c) => c.mcpHttp), (cli) => {
    test(`${cli.provider}: an HTTP MCP server from the tool library, with its secret header kept off the command line`, async ({ page, relay }) => {
      // A name that never resolves: the fakes only say what they were given, and connect nowhere.
      const url = 'https://mcp.example.invalid/e2e';
      await relay.api('/api/tools/mcp/e2e-http', {
        method: 'PUT',
        body: { transport: 'http', url, headers: [{ name: 'Authorization', value: 'Bearer s3cr3t-e2e-header' }] },
      });
      const id = await chatWith(page, relay, cli);
      await send(page, 'Which tools do you have?');
      await expect(await finishedReply(page, cli.name)).toContainText("My tool library's MCP servers: e2e-http.");
      await settled(relay, id);
      // Given as an HTTP server at its URL, with the header and its value…
      const given = await logged(relay, (e) => e.cli === cli.provider && e.mcpEnv?.['e2e-http']);
      const log = relay.fakeLog().filter((e) => e.cli === cli.provider);
      for (const e of given) {
        expect(e.mcpHttp?.['e2e-http']).toBe(url);
        expect(e.mcpEnv!['e2e-http']).toEqual({ Authorization: 'Bearer s3cr3t-e2e-header' });
      }
      // …and the value in no argument the CLI was started with.
      const starts = log.filter((e) => e.args);
      expect(starts.length).toBeGreaterThan(0);
      for (const s of starts) expect(JSON.stringify(s.args)).not.toContain('s3cr3t-e2e-header');
    });
  });

  // The CLIs a prompt's images reach (`images`).
  eachCli(CLIS.filter((c) => c.images), (cli) => {
    test(`${cli.provider}: an attached image`, async ({ page, relay }) => {
      const id = await chatWith(page, relay, cli);
      await page.locator('.composer input[type="file"], .composer-row input[type="file"]').first().setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG });
      await expect(page.getByRole('button', { name: 'Remove dot.png' })).toBeVisible();
      await composer(page).fill('What is in the picture?');
      await composer(page).press('Enter');
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('You said: “What is in the picture?”. I got 1 image.');
      await settled(relay, id);
      // The prompt names the file too, for the agent's own file tools.
      await logged(relay, (e) => e.cli === cli.provider && e.prompt?.includes('dot.png (image/png'));
    });
  });
});
