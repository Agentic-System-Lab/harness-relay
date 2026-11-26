import { expect, test } from '../fixtures';
import { acceptNextDialog, chatId, finishedReply, openTeamChat, replies, send, settled } from '../support/app';

test.describe("changing a chat's history", () => {
  test('a message can be edited and sent again: what came after it is replaced', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Frist question');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “Frist question”.');
    await settled(relay, id);

    const message = page.locator('.msg-user', { hasText: 'Frist question' });
    await message.hover();
    await message.getByRole('button', { name: 'Edit', exact: true }).click();
    const box = page.getByRole('textbox', { name: 'Edit message' });
    await expect(page.locator('.edit-box')).toContainText('Resending deletes everything after this message');
    await box.fill('First question');
    await page.locator('.edit-box').getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.locator('.msg-user')).toHaveText([/First question/]);
    await expect(replies(page, 'Claude')).toHaveCount(1);
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “First question”.');
    const conv = await settled(relay, id);
    expect(conv.messages.map((m) => m.author.kind)).toEqual(['user', 'agent']);
  });

  test('Retry on a finished reply lets the member answer again', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }]);
    await send(page, 'Say it twice');
    const first = await finishedReply(page, 'Grok');
    await settled(relay, id);
    const before = relay.fakeLog().filter((e) => e.cli === 'grok' && e.prompt?.includes('Say it twice')).length;

    await first.hover();
    await first.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => relay.fakeLog().filter((e) => e.cli === 'grok' && e.prompt?.includes('Say it twice')).length).toBe(before + 1);
    await settled(relay, id);
    await expect(replies(page, 'Grok')).toHaveCount(1);
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Say it twice”.');
  });

  test('a conversation branched from a reply goes on by itself, and the original stays as it was', async ({ page, relay }) => {
    const original = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Trunk');
    await send(page, 'Start here');
    const reply = await finishedReply(page, 'Codex');
    await settled(relay, original);

    await reply.hover();
    await reply.getByRole('button', { name: 'Branch conversation' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Create a child branch/ })
      .click();
    await expect.poll(() => chatId(page)).not.toBe(original);
    const branch = chatId(page);
    await expect(page.locator('.chat-head')).toContainText('Continued from');
    await expect(page.locator('.msg-user', { hasText: 'Start here' })).toBeVisible();

    await send(page, 'Only in the branch');
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “Only in the branch”.');
    await settled(relay, branch);
    const trunk = await relay.api<{ messages: { parts: { type: string; text?: string }[] }[] }>(`/api/conversations/${original}`);
    expect(JSON.stringify(trunk.messages)).not.toContain('Only in the branch');
    // In the sidebar, the branch is listed with its original.
    await expect(page.locator('.conv-item')).toHaveCount(2);
  });
  test('new topics from the sidebar and from a reply keep the selected history as separate roots', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Customer interviews');
    const source = page.locator('.conv-item').filter({ has: page.locator(`a[href="#/c/${id}"]`) });
    const sidebarButton = source.getByRole('button', { name: 'Start a conversation from here' });
    const dialog = page.getByRole('dialog');
    await source.hover();
    await sidebarButton.click();
    await expect(dialog).toContainText('Once an agent has finished a reply');
    await page.keyboard.press('Escape');
    await expect(sidebarButton).toBeFocused();
    await send(page, 'Interview findings');
    await finishedReply(page, 'Codex');
    await settled(relay, id);
    await send(page, 'Sales objections');
    await finishedReply(page, 'Codex');
    await settled(relay, id);
    await source.hover();
    await sidebarButton.click();
    await expect(dialog).toContainText('Sales objections');
    await dialog.getByRole('button', { name: /Start a new topic/ }).click();
    await expect.poll(() => chatId(page)).not.toBe(id);
    await expect(page.locator('.composer-row textarea')).toBeFocused();
    await expect(page.locator('.msg-user')).toHaveCount(2);
    await page.locator('.head-branch a').click();
    const first = replies(page, 'Codex').first();
    await first.hover();
    await first.getByRole('button', { name: 'Branch conversation' }).click();
    await expect(dialog).toContainText('Interview findings');
    await page.setViewportSize({ width: 667, height: 320 });
    const childOption = dialog.getByRole('button', { name: /Create a child branch/ });
    await childOption.scrollIntoViewIfNeeded();
    await expect(childOption).toBeInViewport({ ratio: 1 });
    await dialog.getByRole('button', { name: /Start a new topic/ }).click();
    await expect.poll(() => chatId(page)).not.toBe(id);
    await expect(page.locator('.msg-user')).toHaveText([/Interview findings/]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('.conv-item')).toHaveCount(3);
    await expect(page.locator('.conv-children')).toHaveCount(0);

    const topicId = chatId(page);
    const sales = await relay.api<{ id: string }>('/api/groups', { body: { name: 'Sales' } });
    await page.reload();
    const topic = page.locator('.conv-item').filter({ has: page.locator(`a[href="#/c/${topicId}"]`) });
    await topic.hover();
    await topic.getByRole('combobox').selectOption(sales.id);
    await expect(page.getByRole('region', { name: 'Sales', exact: true }).locator('.conv-item')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Other', exact: true }).locator('.conv-item')).toHaveCount(2);
    await source.hover();
    acceptNextDialog(page);
    await source.getByRole('button', { name: 'Delete conversation' }).click();
    await expect(page.locator('.head-branch')).toContainText('Customer interviews (deleted)');
    await send(page, 'Prepare a sales brief');
    await expect(await finishedReply(page, 'Codex')).toContainText('Prepare a sales brief');
    const saved = await settled(relay, topicId);
    expect(saved.messages.filter((m) => m.author.kind === 'user')).toHaveLength(2);
  });
});
