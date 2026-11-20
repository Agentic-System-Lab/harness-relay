import type { Locator, Page } from '@playwright/test';
import { expect } from '../fixtures';
import { finishedReply, send } from './app';
import type { RelayServer } from './relay';

export async function openCommonApp(page: Page, relay: RelayServer, name: string) {
  await page.goto(relay.base + '/#/settings/apps');
  const row = page.getByRole('listitem', { name, exact: true });
  await row.locator('.app-options > summary').click();
  return row;
}

export async function selectAssistant(row: Locator, enabled: boolean) {
  const access = row.locator('.app-chat-access');
  await access.locator('summary').click();
  const claude = access.getByRole('button', { name: 'Claude Code', exact: true });
  await expect(claude).toHaveAttribute('aria-pressed', String(!enabled));
  await claude.click();
  await expect(claude).toHaveAttribute('aria-pressed', String(enabled));
}

export async function checkToolOff(page: Page, chat: string, tool: string, args: Record<string, unknown>, server = 'relay') {
  await page.goto(chat);
  await send(page, 'Check access again: ' + JSON.stringify(args) + ' e2e:mcp=' + tool + ' e2e:mcpserver=' + server);
  await expect(await finishedReply(page, 'Claude')).toContainText(
    new RegExp('The ' + tool + ' tool said: (No MCP server ' + server + '|No such tool: ' + tool + ')'),
  );
}
