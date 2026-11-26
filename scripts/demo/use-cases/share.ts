/**
 * Shares each recorded use case as a person would with Harness Relay's own Share: the recording's
 * server started again on its data folder, its conversation opened in a headless browser, Share → Create
 * link pressed, with the files the replies link to going along (the dialog's default). The page goes up
 * as a secret gist with your own `gh`, read on Harness Relay's viewer (site/share/). `share.json` keeps the link beside
 * the recording, and the files attached to the question are copied next to it (`attachments/`), for
 * publish to put both on the use-cases page. A use case shared again has its last share's gists deleted.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { SHARE_VIEWER_URL } from '../../../src/shared/share';
import type { Conversation, SharedPage } from '../../../src/shared/types';
import type { DemoLang } from '../common';
import { api, signInCode, sleep, startServer, VIEW, type Log } from '../recorder';
import { UI, type UseCase } from './cases';

/** What a use case's share was, as `share.json` keeps it. */
export interface ShareRecord {
  /** The page, on Harness Relay's viewer (`shareViewerUrl()`). */
  url: string;
  /** The page's gist, and the gist of the files that went along (if any), to delete them. */
  gist: string;
  filesGist?: string;
  /** How many files the replies link to went along. */
  files: number;
  /** Shared up to this reply (one still running when the recording ended is left out). */
  upTo?: string;
  /** The files attached to the question, by name, in `attachments/`. */
  attachments: string[];
  sharedAt: string;
}

/** The share kept beside a recording, if any. */
export function readShare(dir: string): ShareRecord | undefined {
  const file = join(dir, 'share.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ShareRecord) : undefined;
}

/** The gist's id at the end of its address. */
const gistId = (url: string) => /([0-9a-f]{20,})\/?$/.exec(url)?.[1];

/**
 * The reply to share up to: none (the whole conversation, the lead agent's review and notes after the
 * replies included) unless the last reply did not finish (it was still running when the recording
 * ended), then the last one that did.
 */
export function shareUpTo(c: Pick<Conversation, 'messages'>): string | undefined {
  const replies = c.messages.filter((m) => m.author.kind === 'agent');
  if (!replies.length || replies.at(-1)!.status === 'done') return undefined;
  return [...replies].reverse().find((m) => m.status === 'done')?.id;
}

/** The files attached to the conversation's messages, copied from the server's data folder into `to`: their names. */
function copyAttachments(c: Conversation, dataDir: string, to: string): string[] {
  rmSync(to, { recursive: true, force: true });
  const names: string[] = [];
  for (const m of c.messages) {
    for (const p of m.parts) {
      if (p.type !== 'attachment') continue;
      const from = join(dataDir, 'attachments', c.id, p.id, p.name);
      if (!existsSync(from)) throw new Error(`The attachment ${p.name} is not in ${dataDir}`);
      mkdirSync(to, { recursive: true });
      copyFileSync(from, join(to, p.name));
      names.push(p.name);
    }
  }
  return names;
}

/** Shares the recording in `dir` (its server's data in `dataDir`, its working directory `cwd`), and returns the share. */
export async function shareUseCase(
  o: { dir: string; dataDir: string; cwd: string; port: number; webDir: string },
  uc: UseCase,
  lang: DemoLang,
  log: Log,
): Promise<ShareRecord> {
  const T = UI[lang];
  const recorded = JSON.parse(readFileSync(join(o.dir, 'conversation.json'), 'utf8')) as Conversation;
  if (!existsSync(join(o.dataDir, 'relay.db'))) throw new Error(`No recording's data in ${o.dataDir}: record ${uc.slug} again`);
  const attachments = copyAttachments(recorded, o.dataDir, join(o.dir, 'attachments'));
  const before = readShare(o.dir);
  const server = await startServer(o.port, o.dataDir, join(o.dir, 'share-server.log'), { cwd: o.cwd, env: { RELAY_WEB_DIR: o.webDir } });
  try {
    const c = await api<Conversation>(server.base, `/api/conversations/${recorded.id}`);
    const upTo = shareUpTo(c);
    const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROME || undefined });
    try {
      const context = await browser.newContext({
        viewport: { width: VIEW.width, height: VIEW.height },
        locale: lang === 'en' ? 'en-US' : 'zh-TW',
        colorScheme: 'light',
      });
      await context.addInitScript((l: string) => {
        localStorage.setItem('relay:onboarded', '99');
        localStorage.setItem('relay:lang', l);
      }, lang);
      const page = await context.newPage();
      await page.goto(`${server.base}/#code=${signInCode(server.base)}`);
      await page.waitForSelector('.home-hero');
      await page.evaluate((id) => (window.location.hash = `#/c/${id}`), c.id);
      await page.waitForSelector('.messages');
      await sleep(2500); // its images drawn
      if (upTo) {
        const reply = page.locator(`[id="msg-${upTo}"]`);
        await reply.scrollIntoViewIfNeeded();
        await reply.getByRole('button', { name: T.message.share, exact: true }).last().click();
      } else {
        const head = page.locator('.chat-head');
        await head.getByRole('button', { name: T.chat.more, exact: true }).click();
        await head.getByRole('button', { name: T.share.button, exact: true }).click();
      }
      const dialog = page.locator('.share-dialog');
      await dialog.waitFor();
      // The files the replies link to, checked by default once the dialog knows them (no list: none).
      await page
        .waitForFunction(
          (checking) => {
            const d = document.querySelector('.share-dialog');
            return Boolean(d?.querySelector('.share-files')) && !d!.textContent!.includes(checking);
          },
          T.share.files.checking,
          { timeout: 15_000 },
        )
        .catch(() => log('no files the replies link to'));
      await sleep(800);
      await dialog.locator('button.primary.share-action').click();
      const link = dialog.locator(`.share-result a[href^="${SHARE_VIEWER_URL}"]`);
      await link.waitFor({ timeout: 5 * 60_000 });
      const url = (await link.getAttribute('href'))!;
      const shared = (await api<SharedPage[]>(server.base, '/api/shares')).find((s) => s.url === url);
      if (!shared) throw new Error(`The server does not list the share ${url}`);
      const record: ShareRecord = {
        url,
        gist: shared.gistUrl,
        ...(shared.filesGist ? { filesGist: shared.filesGist } : {}),
        files: shared.files ?? 0,
        ...(upTo ? { upTo } : {}),
        attachments,
        sharedAt: new Date().toISOString(),
      };
      writeFileSync(join(o.dir, 'share.json'), JSON.stringify(record, null, 1) + '\n');
      log(
        `shared ${url} (${record.files} file(s) along${upTo ? ', up to the last finished reply' : ''}), ${attachments.length} attachment(s)`,
      );
      // The last share of this use case's recording, if another: its gists deleted, so that only one stays.
      if (before && before.url !== url) {
        for (const g of [before.gist, before.filesGist]) {
          const id = g && gistId(g);
          if (!id) continue;
          const r = spawnSync('gh', ['gist', 'delete', id, '--yes'], { encoding: 'utf8' });
          log(r.status === 0 ? `deleted the last share's gist ${id}` : `WARNING: could not delete the gist ${id}: ${r.stderr.trim()}`);
        }
      }
      return record;
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
}
