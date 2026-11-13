/**
 * What the tests do in the UI, as a person would: start a chat, ask, confirm the lead agent's team,
 * find a member's reply. Locators prefer roles and visible text (English, the tests' default
 * language); CSS classes only where the UI gives nothing else.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { AgentConfig, Conversation, ConversationSettings, Mode, Permission } from '../../src/shared/types';
import type { RelayServer } from './relay';

export interface NewChatOptions {
  permission?: Permission;
  /** Use the lead agent's teams without asking (the default asks first). */
  autoConfirm?: boolean;
  title?: string;
}

/** The home page (#/), where the app opens: the logo and its tagline. Shows once the browser is signed in. */
export const homePage = (page: Page) => page.getByRole('heading', { name: 'From now on, let your agent team work for you' });

/** Opens the New chat page from the sidebar. */
export async function openNewChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
}

/** Starts a chat from the New chat page (the lead agent designs each question's team) and waits for it to open. */
export async function startChat(page: Page, o: NewChatOptions = {}): Promise<string> {
  await openNewChat(page);
  if (o.permission) await page.getByRole('button', { name: permissionLabel(o.permission), exact: true }).click();
  const auto = page.getByRole('checkbox', { name: "Use the lead agent's team without asking me" });
  if (o.autoConfirm !== undefined) await auto.setChecked(o.autoConfirm);
  if (o.title) await page.getByPlaceholder(/Conversation title/).fill(o.title);
  await page.getByRole('button', { name: 'Start chat →' }).click();
  await page.waitForURL(/#\/c\//);
  return chatId(page);
}

/** The id of the open chat. */
export function chatId(page: Page): string {
  const m = /#\/c\/([^/?]+)/.exec(page.url());
  if (!m) throw new Error(`No chat is open: ${page.url()}`);
  return decodeURIComponent(m[1]!);
}

export const permissionLabel = (p: Permission) => ({ 'read-only': 'Read-only', edit: 'Edit', full: 'Full access' })[p];

/** The composer's text box. */
export const composer = (page: Page) => page.locator('.composer-row textarea');

/** Types a message and sends it with Enter. */
export async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.fill(text);
  await box.press('Enter');
  await expect(page.locator('.msg-user').filter({ hasText: firstLine(text) }).last()).toBeVisible();
}

const firstLine = (text: string) => text.split('\n')[0]!.replace(/\be2e:\S+/g, '').trim().slice(0, 40) || text.slice(0, 40);

/** The lead agent's team card that waits for the user. */
export const awaitingPlan = (page: Page) => page.locator('.plan-card.awaiting');

/** Confirms the team the lead agent proposed. */
export async function confirmTeam(page: Page): Promise<void> {
  const card = awaitingPlan(page).last();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Confirm team' }).click();
  await expect(awaitingPlan(page)).toHaveCount(0);
}

/** Asks in a new or open auto-team chat and confirms the team: the reply comes next. */
export async function askAndConfirm(page: Page, text: string): Promise<void> {
  await send(page, text);
  await confirmTeam(page);
}

/** A member's replies, by its name in the chat (`Claude`, not `@Claude`). */
export function replies(page: Page, name: string): Locator {
  return page.locator('.msg-agent').filter({ has: page.locator('.msg-head strong', { hasText: new RegExp(`^@${escape(name)}$`) }) });
}

/**
 * A member's latest reply, once it has finished streaming (within `timeoutMs`: a turn in Harness
 * Relay's own sandbox starts the sandbox first, and the first of a server checks that it works).
 */
export async function finishedReply(page: Page, name: string, timeoutMs = 45_000): Promise<Locator> {
  const reply = replies(page, name).last();
  await expect(reply).toBeVisible();
  await expect(reply.locator('.live-tag')).toHaveCount(0, { timeout: timeoutMs });
  return reply;
}

/** Waits until no member is replying and the lead agent is not designing a team. */
export async function settled(relay: RelayServer, id: string, timeoutMs = 30_000): Promise<Conversation> {
  let last: Conversation | undefined;
  await expect
    .poll(
      async () => {
        last = await relay.api<Conversation>(`/api/conversations/${id}`);
        const summary = (await relay.api<{ id: string; running?: boolean }[]>('/api/conversations')).find((c) => c.id === id);
        return !summary?.running && last.messages.every((m) => m.status !== 'streaming');
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
  return last!;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Member {
  name: string;
  provider: AgentConfig['provider'];
  role?: string;
  /** Its model (an open agent's: `<backend>/<model>`, `e2e/e2e-model` say), else its CLI's default. */
  model?: string;
  effort?: string;
  /** The account of its CLI it runs as (`ProviderAccountView.id`), else the default one. */
  account?: string;
}

/**
 * A chat with a team of its own (no lead agent), made through the API, opened in the page: for tests
 * about what happens in a chat rather than how one is started.
 */
export async function openTeamChat(
  page: Page,
  relay: RelayServer,
  members: Member[],
  settings: Partial<ConversationSettings> & { mode?: Mode } = {},
  title = 'Team chat',
): Promise<string> {
  const conv = await relay.api<Conversation>('/api/conversations', {
    body: {
      title,
      agents: members.map((m, i) => ({
        id: `m${i + 1}`,
        name: m.name,
        provider: m.provider,
        role: m.role ?? `You are ${m.name}.`,
        ...(m.model ? { model: m.model } : {}),
        ...(m.effort ? { effort: m.effort } : {}),
        ...(m.account ? { account: m.account } : {}),
      })),
      settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: relay.workDir, ...settings },
    },
  });
  await page.goto(`${relay.base}/#/c/${conv.id}`);
  await expect(composer(page)).toBeVisible();
  return conv.id;
}

/**
 * A team editor card's height, and its height with the add card hidden. They are the same when the
 * add card takes its row's height rather than setting it: comparing the add card with the member
 * beside it proves nothing, as the cards of a grid row are always as tall as each other.
 */
export async function heightWithoutAddCard(page: Page, card: Locator): Promise<{ shown: number; hidden: number }> {
  const shown = (await card.boundingBox())!.height;
  const style = await page.addStyleTag({ content: '.add-card { display: none !important; }' });
  const hidden = (await card.boundingBox())!.height;
  await style.evaluate((el) => (el as Element).remove());
  return { shown, hidden };
}

/** Accepts the next `confirm()` / `alert()` the page shows (Playwright dismisses them by default). */
export function acceptNextDialog(page: Page, answer?: string): void {
  page.once('dialog', (d) => void d.accept(answer));
}
