import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { confirmTeam, finishedReply, openTeamChat, send } from '../support/app';

test.describe('schedules', () => {
  test("a chat's schedule is saved, and running it once sends its message to the team", async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Daily check');
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Check the build');
    await drawer.getByRole('radio', { name: 'Every day' }).click();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    // Saved, it closes; the sidebar shows the chat has a schedule.
    await expect(drawer).toBeHidden();
    await expect(page.locator('.conv-item.active .conv-schedule')).toBeVisible();

    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await expect(drawer.locator('.schedule-status')).toContainText('Every day at');
    await drawer.getByRole('button', { name: 'Run once now' }).click();
    await drawer.getByRole('button', { name: 'Close' }).click();
    const sent = page.locator('.msg-user', { hasText: 'Check the build' });
    await expect(sent).toBeVisible();
    await expect(sent).toContainText('Automation');
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “Check the build”.');
  });

  test('a schedule that tracks a goal shows the progress a reply reports, and switches off once it is reached', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Track the build');
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Check the build e2e:progress=done');
    await drawer.getByRole('textbox', { name: 'Goal to track (optional)' }).fill('The build passes');
    await drawer.getByRole('radio', { name: 'Every day' }).click();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();

    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    const progress = drawer.getByRole('region', { name: 'Progress on the goal' });
    await expect(progress).toContainText('No progress yet');
    await drawer.getByRole('button', { name: 'Run once now' }).click();
    await drawer.getByRole('button', { name: 'Close' }).click();

    // The reply's block is shown as a card, not as text; the agent was told the goal.
    const reply = await finishedReply(page, 'Codex');
    const card = reply.getByRole('note', { name: 'Progress on the goal' });
    await expect(card).toContainText('Done');
    await expect(card).toContainText('“The build passes”: done (Codex).');
    await expect(reply).not.toContainText('<progress');
    await expect(page.locator('.msg-system', { hasText: 'says the goal is reached; the automation is off now' })).toBeVisible();

    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await expect(progress).toContainText('Done');
    await expect(progress.locator('.progress-note')).toHaveCount(1);
    await expect(drawer.getByRole('checkbox', { name: 'On' })).not.toBeChecked();
  });

  test('a run whose reply says its goal is held up marks the chat as needing the user, and keeps the automation on', async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Held up');
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Check the build e2e:progress=blocked');
    await drawer.getByRole('textbox', { name: 'Goal to track (optional)' }).fill('The build passes');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await drawer.getByRole('button', { name: 'Run once now' }).click();
    await drawer.getByRole('button', { name: 'Close' }).click();

    const reply = await finishedReply(page, 'Codex');
    await expect(reply.getByRole('note', { name: 'Progress on the goal' })).toContainText('Blocked');
    await expect(page.locator('.msg-system', { hasText: 'says the goal is held up and needs you' })).toBeVisible();
    // The sidebar says so, and the tab's title counts it, until a later reply says otherwise.
    await expect(page.locator('.conv-item.active .conv-status')).toHaveText('Goal held up');
    await expect(page).toHaveTitle(/\(1\)/);
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await expect(drawer.getByRole('region', { name: 'Progress on the goal' })).toContainText('Blocked');
    await drawer.getByRole('button', { name: 'Close' }).click();

    await send(page, 'The key is in place now');
    await finishedReply(page, 'Codex');
    await expect(page.locator('.conv-item.active .conv-status', { hasText: 'Goal held up' })).toHaveCount(0);
  });

  test("a schedule's webhook shows its token once, and a program's call sends the message with what it posted", async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Hooked');
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('CI reported');
    // No set times: only Run once now and the webhook send it, so there is nothing to switch on or off,
    // and no missed times.
    await drawer.getByRole('radio', { name: 'No set times' }).click();
    await expect(drawer).toContainText('Sent only when you click Run once now, or a program calls its webhook');
    await expect(drawer.getByRole('checkbox', { name: 'On' })).toHaveCount(0);
    await expect(drawer.getByRole('radiogroup', { name: 'Missed times' })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('.conv-item.active .conv-schedule')).toHaveAccessibleName(
      'Automation: no set times (Run once now or its webhook)',
    );

    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await expect(drawer.locator('.schedule-status')).toContainText('No set times · sent by Run once now or its webhook');
    // Folded away under words anyone can read until there is a webhook.
    const hook = drawer.getByRole('region', { name: 'Let another program start it (webhook)' });
    await expect(hook.getByRole('button', { name: 'Add a webhook' })).toBeHidden();
    await hook.getByText('Let another program start it (webhook)').click();
    await hook.getByRole('button', { name: 'Add a webhook' }).click();
    const example = hook.locator('.hook-example');
    // curl, or on a server on Windows PowerShell's own Invoke-RestMethod (cmd.exe takes no single quotes).
    await expect(example).toContainText(process.platform === 'win32' ? 'Invoke-RestMethod -Method Post' : 'curl -X POST');
    const line = (await example.textContent())!;
    const token = /Bearer ([A-Za-z0-9_-]+)/.exec(line)![1]!;
    const url = /'(http:\/\/127\.0\.0\.1:\d+\/api\/hooks\/[^']+)'/.exec(line)![1]!;
    await expect(hook).toContainText('Not called yet');

    // A program on this computer: no browser's sign-in, only the token.
    const call = (bearer: string) =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'ci-failed', branch: 'main' }),
      });
    expect((await call('wrong')).status).toBe(404);
    expect((await call(token)).status).toBe(202);
    await expect(hook).toContainText('Last called');
    await drawer.getByRole('button', { name: 'Close' }).click();

    const sent = page.locator('.msg-user', { hasText: 'CI reported' });
    await expect(sent).toContainText('Automation');
    await sent.getByText('What the webhook sent').click();
    await expect(sent.locator('.event-block pre')).toContainText('"event": "ci-failed"');
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “CI reported');

    // Shown once: opened again, the drawer has no token, only the way to make a new one.
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await expect(hook.locator('.hook-example')).toHaveCount(0);
    await expect(hook.getByRole('button', { name: 'New token' })).toBeVisible();
  });

  test("New automation's Create a webhook too opens the automation's chat with its token shown once, which a program then calls", async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'New automation' }).click();
    await page.getByRole('textbox', { name: 'Message to send the team' }).fill('Deploy finished');
    await page.getByRole('radio', { name: 'No set times' }).click();
    // Folded away at first, under words anyone can read.
    const withHook = page.getByRole('checkbox', { name: 'Create a webhook too' });
    await expect(withHook).toBeHidden();
    await page.getByText('Let another program start it (webhook)').click();
    await expect(withHook).not.toBeChecked();
    await withHook.check();
    await expect(page.getByText("the automation's drawer opens with the webhook's address and token")).toBeVisible();
    await page.getByRole('button', { name: 'Create automation' }).click();
    await page.waitForURL(/#\/c\//);

    // Its drawer opens by itself, the token shown there.
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    const hook = drawer.getByRole('region', { name: 'Let another program start it (webhook)' });
    await expect(hook).toContainText('The token is shown only this once');
    const line = (await hook.locator('.hook-example').textContent())!;
    const token = /Bearer ([A-Za-z0-9_-]+)/.exec(line)![1]!;
    const url = /'(http:\/\/127\.0\.0\.1:\d+\/api\/hooks\/[^']+)'/.exec(line)![1]!;
    await expect(hook.getByRole('button', { name: 'New token' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toBeHidden();
    // Shown once: opened again, no token.
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await expect(hook).toContainText('Not called yet');
    await expect(hook.locator('.hook-example')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Close' }).click();

    // Once the team is confirmed, a program's call sends the message.
    await confirmTeam(page);
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'deployed' }),
    });
    expect(res.status).toBe(202);
    await expect(page.locator('.msg-user', { hasText: 'Deploy finished' })).toContainText('Automation');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “Deploy finished');
  });

  test('an automation that starts when new mail comes checks the inbox itself: the first check only notes what is there, and a mail that arrives after it reaches the team, its sender and subject in the message', async ({
    page,
    relay,
  }) => {
    const imap = await imapServer([mailFrom(1, 'Old <old@example.com>', 'Already here')]);
    try {
      await relay.api('/api/connectors/mail/work', {
        method: 'PUT',
        body: {
          name: 'Work',
          address: 'me@example.com',
          username: 'me@example.com',
          password: 'app-pass',
          imap: { host: '127.0.0.1', port: imap.port, security: 'none' },
          smtp: { host: '127.0.0.1', port: imap.port, security: 'none' },
        },
      });
      await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Mail watch');
      await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
      const drawer = page.getByRole('dialog', { name: 'Automation' });
      await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Triage the new mail');
      await drawer.getByRole('radio', { name: 'When something happens' }).click();
      // The account from Settings, picked as the only one; no times, so no missed times.
      await expect(drawer.getByRole('combobox', { name: 'Mail account' })).toHaveValue('work');
      await expect(drawer.getByRole('radiogroup', { name: 'Missed times' })).toHaveCount(0);
      await expect(drawer).toContainText('The first check only notes the mail already there');
      await drawer.getByRole('textbox', { name: 'The sender contains (optional)' }).fill('carol');
      await drawer.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(drawer).toBeHidden();
      await expect(page.locator('.conv-item.active .conv-schedule')).toHaveAccessibleName('Automation: when a new mail from carol arrives');

      // Check now: the first check notes the mail already there, and sends nothing.
      await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
      await drawer.getByRole('button', { name: 'Check now' }).click();
      await expect(drawer.locator('.schedule-status')).toContainText('When a new mail from carol arrives · Checked');
      expect(imap.logins()).toBeGreaterThan(0);

      // Two mails arrive: only Carol's matches.
      imap.messages.push(mailFrom(2, 'Bob <bob@example.com>', 'Lunch?'), mailFrom(3, 'Carol <carol@example.com>', 'Invoice 42'));
      await drawer.getByRole('button', { name: 'Check now' }).click();
      await expect(drawer.locator('.schedule-status')).toContainText('sent');
      await drawer.getByRole('button', { name: 'Close' }).click();

      const sent = page.locator('.msg-user', { hasText: 'Triage the new mail' });
      await expect(sent).toHaveCount(1);
      await expect(sent).toContainText('Automation');
      await sent.getByText('The new mail', { exact: true }).click();
      const block = sent.locator('.event-block pre');
      await expect(block).toContainText('"subject": "Invoice 42"');
      await expect(block).not.toContainText('Lunch?');
      await expect(block).not.toContainText('Already here');
      // The agent gets it as data, said to come from mail.
      const reply = await finishedReply(page, 'Codex');
      await expect(reply).toContainText('<event source="mail">');
      await expect(reply).toContainText('Invoice 42');
    } finally {
      await imap.close();
    }
  });

  test('an automation that starts when a file appears in the working directory: the first check notes the files there, and a new one reaches the team by its path, never its contents', async ({
    page,
    relay,
  }) => {
    mkdirSync(join(relay.workDir, 'reports'), { recursive: true });
    writeFileSync(join(relay.workDir, 'reports', 'jan.csv'), 'month,total\njan,1\n');
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Report watch');
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Automation' });
    await drawer.getByRole('textbox', { name: 'Message to send the team' }).fill('Summarize the new report');
    await drawer.getByRole('radio', { name: 'When something happens' }).click();
    await drawer
      .getByRole('combobox', { name: 'What to wait for' })
      .selectOption({ label: 'A file appears or changes in the working directory' });
    await drawer.getByRole('textbox', { name: 'File pattern' }).fill('reports/*.csv');
    await expect(drawer).toContainText('never its contents');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('.conv-item.active .conv-schedule')).toHaveAccessibleName(
      'Automation: when a file matching reports/*.csv appears or changes in the working directory',
    );

    // Check now: the first check notes jan.csv, and sends nothing.
    await page.locator('.chat-head').getByRole('button', { name: 'Automation' }).click();
    await drawer.getByRole('button', { name: 'Check now' }).click();
    await expect(drawer.locator('.schedule-status')).toContainText('Checked');
    await expect(page.locator('.msg-user', { hasText: 'Summarize the new report' })).toHaveCount(0);

    // A new report, and a file the pattern leaves out.
    writeFileSync(join(relay.workDir, 'reports', 'feb.csv'), 'month,total\nfeb,SECRET-TOTAL\n');
    writeFileSync(join(relay.workDir, 'reports', 'notes.txt'), 'not a report');
    await drawer.getByRole('button', { name: 'Check now' }).click();
    await expect(drawer.locator('.schedule-status')).toContainText('sent');
    await drawer.getByRole('button', { name: 'Close' }).click();

    const sent = page.locator('.msg-user', { hasText: 'Summarize the new report' });
    await expect(sent).toHaveCount(1);
    await sent.getByText('The files that appeared or changed', { exact: true }).click();
    const block = sent.locator('.event-block pre');
    await expect(block).toContainText('"path": "reports/feb.csv"');
    await expect(block).toContainText('"change": "new"');
    await expect(block).not.toContainText('jan.csv');
    await expect(block).not.toContainText('notes.txt');
    await expect(block).not.toContainText('SECRET-TOTAL');
    const reply = await finishedReply(page, 'Codex');
    await expect(reply).toContainText('<event source="file">');
    await expect(reply).toContainText('reports/feb.csv');
  });
});

/** A mail in the stand-in IMAP server: its UID, sender and subject, and a line of text. */
function mailFrom(uid: number, from: string, subject: string): { uid: number; raw: string } {
  return {
    uid,
    raw: `From: ${from}\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: Mon, 05 Jan 2026 09:00:00 +0000\r\nMessage-ID: <m${uid}@example.com>\r\n\r\nHello from ${from}.\r\n`,
  };
}

/**
 * A mail server's IMAP on this computer, enough for an automation's checks: sign-in with this user and
 * password, INBOX with its UIDVALIDITY and UIDNEXT, `UID SEARCH UID n:*`, and `UID FETCH` of headers or
 * whole mails. Push to `messages` for mail that arrives.
 */
async function imapServer(
  messages: { uid: number; raw: string }[],
): Promise<{ port: number; messages: { uid: number; raw: string }[]; logins: () => number; close: () => Promise<void> }> {
  let logins = 0;
  const server = createServer((sock) => {
    let buf = '';
    sock.write('* OK e2e IMAP\r\n');
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      for (;;) {
        const eol = buf.indexOf('\r\n');
        if (eol < 0) return;
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        const top = Math.max(0, ...messages.map((m) => m.uid));
        if (/^LOGIN "me@example.com" "app-pass"$/i.test(cmd)) (logins++, sock.write(`${tag} OK signed in\r\n`));
        else if (/^LOGIN/i.test(cmd)) sock.write(`${tag} NO wrong password\r\n`);
        else if (/^CAPABILITY/i.test(cmd)) sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
        else if (/^EXAMINE "INBOX"/i.test(cmd))
          sock.write(
            `* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT ${top + 1}] ok\r\n${tag} OK [READ-ONLY] done\r\n`,
          );
        else if (/^UID SEARCH UID (\d+):\*/i.test(cmd)) {
          const from = Number(/UID (\d+):/i.exec(cmd)![1]);
          const uids = messages.map((m) => m.uid).filter((u) => u >= Math.min(from, top));
          sock.write(`* SEARCH ${uids.join(' ')}\r\n${tag} OK\r\n`);
        } else if (/^UID FETCH ([\d,]+)/i.test(cmd)) {
          const wanted = /^UID FETCH ([\d,]+)/i.exec(cmd)![1]!.split(',').map(Number);
          const headers = /HEADER\.FIELDS/i.test(cmd);
          for (const m of messages.filter((x) => wanted.includes(x.uid))) {
            const data = headers ? `${m.raw.split('\r\n\r\n')[0]}\r\n\r\n` : m.raw;
            sock.write(`* ${m.uid} FETCH (UID ${m.uid} BODY[] {${Buffer.byteLength(data, 'latin1')}}\r\n${data})\r\n`);
          }
          sock.write(`${tag} OK fetched\r\n`);
        } else if (/^LOGOUT/i.test(cmd)) (sock.write(`* BYE\r\n${tag} OK\r\n`), sock.end());
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as { port: number }).port,
    messages,
    logins: () => logins,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
