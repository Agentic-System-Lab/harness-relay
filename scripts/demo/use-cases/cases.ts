/**
 * The five use cases the website shows (`site/use-cases/`), each recorded by `npm run use-cases` with the
 * real CLIs: what each one sets up, types and clicks, in both languages, and the chapters of its rail.
 * Every recording starts on a fresh server and in a fresh working directory (`workspaces.ts`).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator } from 'playwright-core';
import type { ChatMessage, Conversation, Permission, Provider } from '../../../src/shared/types';
import { en } from '../../../src/web/locales/en';
import { zhTW, type Messages } from '../../../src/web/locales/zh-TW';
import type { ChapterSpec } from '../chapters';
import type { DemoLang } from '../common';
import { api, firstRound, sleep, type ApprovalPolicy, type Session } from '../recorder';
import { ME, billSplit, calendar, mailbox, pocketBudget, tickets } from './workspaces';

export const UI: Record<DemoLang, Messages> = { en, 'zh-TW': zhTW };

/** What a use case's recording is given: its working directory, and what its setup started. */
export interface Prepared {
  cwd: string;
  /** Files to attach to the question. */
  attach?: string[];
  /** Run once the recording is over (the stand-in mail servers stopped). */
  close?: () => Promise<void>;
  /** What the stand-in servers saw, for the review notes. */
  notes?: () => string[];
}

export interface UseCase {
  slug: string;
  /** The CLIs its question names or its team needs. */
  providers: readonly Provider[];
  approvals: ApprovalPolicy;
  /** Seconds the cut video aims for. */
  length: number;
  /** The poster's frame: this mark's time in the video plus `offset` seconds (`fallback`'s when the mark never came). */
  poster: { at: string; offset: number; fallback: string };
  /** Makes the working directory (and anything else the run needs) under `root`. */
  prepare(lang: DemoLang, root: string): Promise<Prepared>;
  /** Run against the server before the browser opens: accounts and tools the recording does not show being set up. */
  setup?(base: string, prepared: Prepared, lang: DemoLang): Promise<void>;
  /** Where the recording starts, and what to wait for there. */
  start: { hash: string; ready: string };
  /** What is typed, per language. */
  text: Record<DemoLang, Record<string, string>>;
  drive(s: Session, p: Prepared): Promise<string>;
  /** The chapter rail, per language. */
  rail: Record<DemoLang, ChapterSpec[]>;
}

const M = (s: Session) => UI[s.lang];

/** A working directory made anew: the last recording's left nothing behind. */
function fresh(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
const idFromUrl = (url: string) => decodeURIComponent(/#\/c\/([^/?]+)/.exec(url)?.[1] ?? '');

/** On the New chat page: picks the permission, sets lead review, starts the chat. Returns its id. */
async function startChat(s: Session, o: { permission: Permission; leadReview: boolean }): Promise<string> {
  const { page, moveClick, mark } = s;
  await s.moveTo(700, 420, 300);
  await sleep(1200);
  if (o.permission !== 'read-only') {
    await moveClick(page.locator('.new-chat-page').getByRole('button', { name: M(s).permissions[o.permission].label, exact: true }), {
      after: 900,
    });
    mark('permission', { permission: o.permission });
  }
  // Lead review is ticked in every new chat; unticked without the cursor, as the demo does.
  if (!o.leadReview) await page.locator('.lead-review input[type="checkbox"]').uncheck();
  await moveClick('.start-bar .primary', { after: 900 });
  await page.waitForURL(/#\/c\//);
  const id = idFromUrl(page.url());
  s.log('conversation', id);
  await sleep(1000);
  mark('chat-open');
  return id;
}

/** Attaches files with the message box's 📎 button, as a person would pick them. */
async function attach(s: Session, files: string[]): Promise<void> {
  const chooser = s.page.waitForEvent('filechooser');
  await s.moveClick(s.page.getByRole('button', { name: M(s).composer.attach }), { after: 200 });
  await (await chooser).setFiles(files);
  await s.page
    .locator('.attach-tray li')
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  await sleep(900);
  s.mark('attached', { files: files.length });
}

/** Asks, then has the lead agent's team confirmed and its answers waited for. */
async function askTeam(s: Session, id: string, question: string): Promise<void> {
  await s.ask(question);
  s.mark('asked', { question });
  const plan = await s.designAndConfirm(id, 'q1', { poster: false });
  await s.waitAnswered(id, 'q1', firstRound(plan));
  await sleep(800);
}

/** Reads back over the replies: up, then down to the end. */
async function readBack(s: Session, up = 1400): Promise<void> {
  await s.scrollMessages(-up, 2600);
  await sleep(1600);
  await s.scrollMessages(up / 2, 2000);
  await sleep(1400);
  await s.scrollMessages(4000, 1500);
  await sleep(900);
}

/** Opens a file in the Files panel by the folders on its path, and holds on its preview. */
async function openFile(s: Session, path: string[], hold = 3500): Promise<void> {
  const { page, moveClick } = s;
  await moveClick(page.getByRole('button', { name: new RegExp(`^${M(s).chat.files}$`) }), { after: 900 });
  await page.waitForSelector('.file-browser');
  for (const name of path) {
    await moveClick(page.locator('.file-list .file-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }), {
      after: 800,
    });
  }
  await sleep(hold);
}

/** The replies that changed files, each with how many lines it changed. */
function changeCards(c: Conversation): { m: ChatMessage; lines: number }[] {
  return c.messages.flatMap((m) =>
    m.changes?.length
      ? [{ m, lines: m.changes.reduce((n, ch) => n + ch.files.reduce((k, f) => k + (f.added ?? 0) + (f.deleted ?? 0), 0), 0) }]
      : [],
  );
}

/** The first file an agent saved with this extension (its path in its repository, as the changed-files card lists it). */
function changedFile(c: Conversation, ext: RegExp): string | undefined {
  for (const m of c.messages) {
    for (const ch of m.changes ?? []) {
      const f = ch.files.find((x) => ext.test(x.path) && x.status !== 'D');
      if (f) return f.path;
    }
  }
  return undefined;
}

// --- 1. Fix a bug three ways ----------------------------------------------------------------------

const fixABug: UseCase = {
  slug: 'fix-a-bug',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 75,
  poster: { at: 'diff', offset: 2.4, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'bill-split'));
    billSplit(cwd);
    return { cwd };
  },
  start: { hash: '#/new', ready: '.new-chat-page .preset-card' },
  text: {
    en: {
      question:
        'The tests fail: splitBill gains or loses a cent when the bill doesn’t divide evenly. Have Claude Code, Codex and Grok each fix it in parallel, each in the git worktree Harness Relay gives it, and run npm test there.',
    },
    'zh-TW': {
      question:
        '測試沒過：帳單無法整除時，splitBill 會多算或少算一分錢。請 Claude Code、Codex 和 Grok 平行修好它，每位在 Harness Relay 給它的 git worktree 裡修，並在那裡跑 npm test。',
    },
  },
  async drive(s) {
    const { page, moveClick, mark } = s;
    const id = await startChat(s, { permission: 'edit', leadReview: false });
    await askTeam(s, id, this.text[s.lang]!.question!);
    await readBack(s, 1600);
    mark('q1-read');

    // The smallest change that the team made: its diff, then into the working directory.
    const c = await s.conversation(id);
    const cards = changeCards(c);
    const best = [...cards].sort((a, b) => a.lines - b.lines)[0];
    if (!best) {
      s.log('WARNING: no reply changed a file');
      return id;
    }
    const card: Locator = page.locator(`[id="msg-${best.m.id}"] .changes-card`).last();
    const target = (await card.count()) ? card : page.locator('.changes-card').nth(cards.indexOf(best));
    await s.scrollToElement(target, 1600, 160);
    await sleep(1200);
    mark('diff', { agent: best.m.agentName, provider: best.m.provider, lines: best.lines });
    await moveClick(target.getByRole('button', { name: M(s).changes.turnDiff }), { after: 1200 });
    await sleep(3200);
    await page.keyboard.press('Escape');
    await sleep(900);
    mark('apply', { agent: best.m.agentName, provider: best.m.provider });
    await moveClick(target.getByRole('button', { name: M(s).changes.apply }), { after: 1500 });
    await page
      .locator('.changes-card')
      .filter({ hasText: M(s).changes.stale })
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    await sleep(2500);
    return id;
  },
  rail: {
    en: [
      {
        at: 'start',
        kind: 'you',
        say: 'Start a new conversation in bill-split with Edit, so the agents may change files and run its tests.',
      },
      {
        at: 'chat-open',
        kind: 'you',
        say: 'Ask: the tests fail, splitBill gains or loses a cent. Have all three fix it in parallel, each in its own worktree.',
      },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, each on its own, and says why.' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: 'Each fixes it in a git worktree of its own, then runs npm test there.' },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command its permission does not cover: you allow it.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'Three fixes side by side, each with the files it changed.' },
      { at: 'diff', kind: 'you', say: 'Open the smallest fix’s diff, @{diff:agent}’s.' },
      {
        at: 'apply',
        kind: 'you',
        say: 'Apply it to the working directory, uncommitted; the other results’ cards then say one of them was applied.',
      },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '在 bill-split 開新對話，權限選「可編輯」，agent 才能改檔案、跑測試。' },
      { at: 'chat-open', kind: 'you', say: '提問：測試沒過，splitBill 會多算或少算一分錢。請三位平行修好，每位在自己的 worktree 裡。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，各自處理，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '每位在自己的 git worktree 裡修正，再在那裡跑 npm test。' },
      { at: 'approval', kind: 'agent', say: '要執行權限之外的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '三種修法並排，各自列出改了哪些檔案。' },
      { at: 'diff', kind: 'you', say: '打開改動最小的修法：@{diff:agent} 的差異。' },
      { at: 'apply', kind: 'you', say: '套用到工作目錄，不會自動 commit；其他結果的卡片隨即註明已套用其中一份。' },
    ],
  },
};

// --- 2. Research a decision ------------------------------------------------------------------------

const research: UseCase = {
  slug: 'research',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 70,
  poster: { at: 'review', offset: 2, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'date-library'));
    writeFileSync(
      join(cwd, 'NOTES.md'),
      lang === 'en'
        ? '# Choosing a date library\n\nOur web app (TypeScript, React) shows times in each user’s time zone and schedules reminders across time zones.\nToday it uses Moment.js, which is in maintenance mode.\n'
        : '# 選擇日期函式庫\n\n我們的網頁 app（TypeScript、React）要依每位使用者的時區顯示時間，也要跨時區排程提醒。\n目前用的是 Moment.js，它已進入維護模式。\n',
    );
    return { cwd };
  },
  start: { hash: '#/new', ready: '.new-chat-page .preset-card' },
  text: {
    en: {
      question:
        'Read NOTES.md. Should we replace Moment.js with date-fns, Day.js or Luxon? Have Claude Code, Codex and Grok look up each one’s docs and npm page, compare time-zone support, size and upkeep, debate it, and give us one pick with links to the sources.',
    },
    'zh-TW': {
      question:
        '先讀 NOTES.md。我們該用 date-fns、Day.js 還是 Luxon 取代 Moment.js？請 Claude Code、Codex 和 Grok 查各自的文件和 npm 頁面，比較時區支援、大小和維護狀況，彼此辯論後給我們一個選擇，並附上來源連結。',
    },
  },
  async drive(s) {
    const { page, mark } = s;
    const id = await startChat(s, { permission: 'read-only', leadReview: true });
    await askTeam(s, id, this.text[s.lang]!.question!);
    await readBack(s, 2200);
    mark('q1-read');
    // The lead agent's review of the answers, at the end of the chat.
    const review = page.locator('.review-card').last();
    if (await review.count()) {
      await s.scrollToElement(review, 1600, 80);
      mark('review');
      await sleep(4500);
      await s.scrollMessages(500, 1600);
      await sleep(2500);
    }
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation, read-only, with lead review on.' },
      { at: 'chat-open', kind: 'you', say: 'Ask which library should replace Moment.js: date-fns, Day.js or Luxon, with sources.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, {rounds}, and says why.' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: 'Each searches the web and reads the docs, then answers the others’ points.' },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command read-only does not cover by itself: you allow it.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'One pick, with the trade-offs and the links they read.' },
      { at: 'review', kind: 'lead', team: 'q1', say: 'Reviews the replies: where they disagree, and what you should check yourself.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限維持唯讀，首席 agent 審閱保持開啟。' },
      { at: 'chat-open', kind: 'you', say: '提問：date-fns、Day.js、Luxon，哪個該取代 Moment.js？要附來源。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，{rounds}，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '每位上網搜尋、讀文件，再回應其他人的論點。' },
      { at: 'approval', kind: 'agent', say: '要執行唯讀權限本身不涵蓋的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '建議與取捨，附上他們讀過的連結；第二輪裡有成員改變了立場。' },
      { at: 'review', kind: 'lead', team: 'q1', say: '審閱回覆：哪裡意見不同、哪些該由你親自確認。' },
    ],
  },
};

// --- 3. Write in relay -----------------------------------------------------------------------------

const writeInRelay: UseCase = {
  slug: 'release-notes',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 70,
  poster: { at: 'files', offset: 5, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'pocket-budget'));
    pocketBudget(cwd);
    return { cwd };
  },
  start: { hash: '#/new', ready: '.new-chat-page .preset-card' },
  text: {
    en: {
      question:
        'Write the release notes for 1.4.0 in RELEASE_NOTES.md, for our users, from the commits since v1.3.0. Pass it along as a relay: Claude Code drafts, Codex edits it into plain words, Grok checks every line against the commits.',
    },
    'zh-TW': {
      question:
        '根據 v1.3.0 之後的 commit，幫使用者寫 1.4.0 的版本說明，存成 RELEASE_NOTES.md。用接力的方式：Claude Code 起草，Codex 改成白話，Grok 逐行對照 commit 查核。',
    },
  },
  async drive(s) {
    const { mark } = s;
    const id = await startChat(s, { permission: 'edit', leadReview: false });
    await askTeam(s, id, this.text[s.lang]!.question!);
    await readBack(s, 1800);
    mark('q1-read');
    const notes = changedFile(await s.conversation(id), /RELEASE_NOTES\.md$/i) ?? 'RELEASE_NOTES.md';
    mark('files', { file: notes });
    await openFile(s, notes.split('/'), 3000);
    await s.page.evaluate(async () => {
      const box = document.querySelector('.file-browser .preview-markdown');
      for (let i = 0; i < 60 && box; i++) {
        box.scrollTop += 5;
        await new Promise((r) => setTimeout(r, 16));
      }
    });
    await sleep(2500);
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation in pocket-budget with Edit, so the agents may write the file.' },
      { at: 'chat-open', kind: 'you', say: 'Ask for 1.4.0’s release notes from the commits since v1.3.0, as a relay.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, in relay, and says why.' },
      {
        at: 'q1-confirmed',
        kind: 'team',
        team: 'q1',
        say: 'Each takes the file from the last and hands it on with an @mention: draft, plain words, fact check.',
      },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command its permission does not cover: you allow it.' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: 'A line that fails the check goes back to the editor, then passes; each reply lists the file it changed.',
      },
      { at: 'files', kind: 'you', say: 'Open RELEASE_NOTES.md in Files, rendered as it will read.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '在 pocket-budget 開新對話，權限選「可編輯」，agent 才能寫檔案。' },
      { at: 'chat-open', kind: 'you', say: '請他們用接力的方式，根據 v1.3.0 之後的 commit 寫 1.4.0 的版本說明。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，以接力進行，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '每位接過上一位的檔案，再用 @ 交棒：起草、改白話、查核。' },
      { at: 'approval', kind: 'agent', say: '要執行權限之外的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '查核沒過的句子退回改寫，再通過查核；每則回覆都列出它改了哪個檔案。' },
      { at: 'files', kind: 'you', say: '在「檔案」打開 RELEASE_NOTES.md，看排版後的樣子。' },
    ],
  },
};

// --- 4. Analyze a spreadsheet ----------------------------------------------------------------------

const analyzeData: UseCase = {
  slug: 'analyze-data',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 70,
  poster: { at: 'chart', offset: 2, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'support-report'));
    writeFileSync(
      join(cwd, 'README.md'),
      lang === 'en' ? '# Support report\n\nThe weekly support update.\n' : '# 客服報告\n\n每週的客服更新。\n',
    );
    const uploads = fresh(join(root, 'uploads'));
    const csv = join(uploads, 'tickets-2026-q3.csv');
    writeFileSync(csv, tickets(lang));
    return { cwd, attach: [csv] };
  },
  start: { hash: '#/new', ready: '.new-chat-page .preset-card' },
  text: {
    en: {
      question:
        'Here are last quarter’s support tickets. What changed, what is driving it, and what should we fix first? Save a chart I can paste into the weekly update, and show it here.',
    },
    'zh-TW': { question: '這是上一季的客服工單。哪裡變了、原因是什麼、我們該先修什麼？存一張可以貼進週報的圖表，並在這裡顯示。' },
  },
  async drive(s, p) {
    const { page, mark } = s;
    const id = await startChat(s, { permission: 'edit', leadReview: false });
    await attach(s, p.attach ?? []);
    await askTeam(s, id, this.text[s.lang]!.question!);
    await readBack(s, 1600);
    // The chart a reply shows.
    const chart = page.locator('.messages img.chat-media').last();
    if (await chart.count()) {
      await s.scrollToElement(chart, 1800, 140);
      mark('chart');
      await sleep(4500);
    }
    mark('q1-read');
    const file = changedFile(await s.conversation(id), /\.(svg|png)$/i);
    if (file) {
      mark('files', { file });
      await openFile(s, file.split('/'), 4000);
    }
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation with Edit, so the agents may save files.' },
      { at: 'chat-open', kind: 'you', say: 'Attach the quarter’s tickets, a CSV file, and ask what changed and what to fix first.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, and says why.' },
      {
        at: 'q1-confirmed',
        kind: 'team',
        team: 'q1',
        say: 'They read the file, count with scripts of their own and check each other’s numbers.',
      },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command its permission does not cover: you allow it.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'What changed and why, ranked by what to fix first.' },
      { at: 'chart', kind: 'you', say: 'The chart they drew, shown right in the reply.' },
      { at: 'files', kind: 'you', say: 'Open it in Files, saved in the working directory for the weekly update.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限選「可編輯」，agent 才能存檔。' },
      { at: 'chat-open', kind: 'you', say: '附上這一季的工單 CSV 檔，問哪裡變了、該先修什麼。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '他們讀檔案、自己寫程式計算，並互相核對數字。' },
      { at: 'approval', kind: 'agent', say: '要執行權限之外的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '哪裡變了、為什麼，依該先修的順序排好。' },
      { at: 'chart', kind: 'you', say: '他們畫的圖表，直接顯示在回覆裡。' },
      { at: 'files', kind: 'you', say: '在「檔案」打開它：已存在工作目錄，可以貼進週報。' },
    ],
  },
};

// --- 5. A morning briefing, every weekday ----------------------------------------------------------

const morningBriefing: UseCase = {
  slug: 'morning-briefing',
  providers: ['claude', 'codex'],
  approvals: 'allow',
  length: 75,
  poster: { at: 'outbox', offset: 2, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'assistant'));
    writeFileSync(
      join(cwd, 'README.md'),
      lang === 'en' ? '# Assistant\n\nNotes the morning briefing keeps.\n' : '# 助理\n\n晨間簡報留下的筆記。\n',
    );
    const { fakeImap, fakeSmtp, fakeCalDav } = await import('../../../test/fake-mail-servers');
    const login = { user: ME.user, pass: ME.pass };
    const imap = await fakeImap(mailbox(lang), login);
    const smtp = await fakeSmtp(login);
    const cal = await fakeCalDav(calendar(lang), login);
    servers.set(cwd, { imap: imap.port, smtp: smtp.port, cal: cal.url });
    return {
      cwd,
      close: async () => {
        await Promise.all([imap.close(), smtp.close(), cal.close()]);
      },
      notes: () =>
        smtp.sent.map(
          (m) =>
            `Sent through the stand-in SMTP server to ${m.to.join(', ')}: ${
              m.data
                .split(/\r?\n\r?\n/)[0]
                ?.split(/\r?\n/)
                .find((l) => l.startsWith('Subject:')) ?? ''
            }`,
        ),
    };
  },
  async setup(base, p, lang) {
    const at = servers.get(p.cwd)!;
    const name = lang === 'en' ? 'Work' : '工作';
    await api(
      base,
      '/api/connectors/mail/work',
      {
        name,
        address: `${ME.name} <${ME.address}>`,
        username: ME.user,
        password: ME.pass,
        imap: { host: '127.0.0.1', port: at.imap, security: 'none' },
        smtp: { host: '127.0.0.1', port: at.smtp, security: 'none' },
      },
      'PUT',
    );
    await api(
      base,
      '/api/connectors/calendar/work',
      { name, url: at.cal, username: ME.user, address: ME.address, password: ME.pass },
      'PUT',
    );
    await api(base, '/api/tools', { relayTools: { mail: ['claude', 'codex'], calendar: ['claude', 'codex'] } }, 'PUT');
  },
  start: { hash: '#/new', ready: '.new-chat-page .preset-card' },
  text: {
    en: {
      message:
        'Every weekday morning, with Harness Relay’s mail and calendar tools: read the mail that came in since yesterday and today’s calendar, and tell me what needs me today. Answer each mail that needs a reply with mail_send: it sends nothing by itself, each reply waits in my outbox until I press Send (an unattended run cannot save drafts). For each meeting request, propose a free time in the reply. Claude Code reads the mail, Codex checks the calendar.',
    },
    'zh-TW': {
      message:
        '每個工作日早上，用 Harness Relay 的郵件和行事曆工具：讀昨天以來的新信和今天的行事曆，告訴我今天有哪些事需要我。需要回覆的信，用 mail_send 寫好簡短的回信：它不會自己寄出，每封回信都在待送出匣等我按「送出」（無人值守的執行不能存草稿）。每個會議邀約，都在回信裡提一個空檔。Claude Code 讀信，Codex 看行事曆。',
    },
  },
  async drive(s) {
    const { page, moveClick, mark, typeSlow } = s;
    const T = M(s);
    await s.moveTo(700, 420, 300);
    await sleep(1000);
    // New automation, beside New chat.
    await moveClick(page.getByRole('button', { name: T.sidebar.newSchedule, exact: true }), { after: 900 });
    await page.waitForSelector('.new-chat-page .schedule-form');
    await sleep(1200);
    // The message, then every weekday at 08:30.
    await moveClick(page.locator('.schedule-form textarea').first(), { after: 250 });
    await typeSlow(this.text[s.lang]!.message!, 22);
    await sleep(700);
    await moveClick(page.locator('.schedule-kinds button', { hasText: T.schedule.kinds.weekly }), { after: 700 });
    // Monday to Friday, by each day's name (the picker starts on Monday, and may start with some days on).
    const weekdays = new Set([1, 2, 3, 4, 5].map((d) => T.schedule.weekdayNames[d]));
    const days = page.locator('.day-picker button');
    for (let i = 0; i < (await days.count()); i++) {
      const day = days.nth(i);
      const want = weekdays.has((await day.getAttribute('aria-label')) ?? '');
      const on = (await day.getAttribute('aria-pressed')) === 'true';
      if (want !== on) await moveClick(day, { after: 250, ms: 300 });
    }
    const time = page.locator('.schedule-when input[type="time"]');
    await moveClick(time, { after: 200 });
    await time.fill('08:30');
    await sleep(1200);
    mark('when', { repeat: 'weekly' });
    // Without lead review, as in the other recordings but one.
    await page
      .locator('.lead-review input[type="checkbox"]')
      .uncheck()
      .catch(() => {});
    await moveClick('.start-bar .primary', { after: 900 });
    await page.waitForURL(/#\/c\//);
    const id = idFromUrl(page.url());
    s.log('conversation', id);
    mark('created');

    // The lead agent designs the team for the message; nothing runs until it is due, or run now.
    const plan = await s.designAndConfirm(id, 'q1');
    await sleep(800);
    mark('run-now');
    await moveClick(page.getByRole('button', { name: new RegExp(`^${T.schedule.button}$`) }), { after: 900 });
    await page.waitForSelector('.schedule-drawer');
    await sleep(1200);
    await moveClick(page.locator('.schedule-drawer').getByRole('button', { name: T.schedule.runNow }), { after: 1200 });
    await page.keyboard.press('Escape');
    await sleep(500);
    await s.waitAnswered(id, 'q1', firstRound(plan));
    await sleep(800);
    await readBack(s, 1800);
    mark('q1-read');

    // What waits in the outbox: send one, as it is shown.
    const outbox = page.locator('.outbox-card.outbox-pending');
    if (await outbox.count()) {
      const first = outbox.first();
      await s.scrollToElement(first, 1600, 120);
      mark('outbox', { items: await outbox.count() });
      await sleep(3500);
      await moveClick(first.getByRole('button', { name: T.outbox.send, exact: true }), { after: 1500 });
      mark('sent');
      await sleep(3000);
    }
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'New automation: what to send the team every weekday at 08:30, read-only.' },
      { at: 'created', kind: 'you', say: 'Create it: a conversation opens for it, and nothing runs yet.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: 'Designs the team for the message: {names}, and says why.' },
      { at: 'run-now', kind: 'you', say: 'Run once now, to try it before its first morning.' },
      {
        at: 'q1-answering',
        kind: 'team',
        team: 'q1',
        say: 'They search and read the mail and the day’s events with Harness Relay’s mail and calendar tools.',
      },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'What needs you today, and the replies they put in your outbox.' },
      { at: 'outbox', kind: 'you', say: 'Nothing went out in their turn: each reply waits in the outbox, field by field.' },
      { at: 'sent', kind: 'you', say: 'Send one as shown, from your own account; Discard would drop it.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '新自動任務：每個工作日 08:30 要交給團隊的事，權限唯讀。' },
      { at: 'created', kind: 'you', say: '建立後會開一段它的對話，這時還不會執行。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '為這則訊息設計團隊：{names}，並說明原因。' },
      { at: 'run-now', kind: 'you', say: '按「立即執行一次」，在第一個早上之前先試跑。' },
      { at: 'q1-answering', kind: 'team', team: 'q1', say: '他們用 Harness Relay 的郵件和行事曆工具搜尋、讀信，查看當天行程。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '今天需要你處理的事，以及他們放進待送出匣的回覆。' },
      { at: 'outbox', kind: 'you', say: '他們的回合裡什麼都沒送出：每封回覆都在待送出匣等你，逐欄列出。' },
      { at: 'sent', kind: 'you', say: '按「送出」，照所示用你自己的帳號寄出一封；「捨棄」會丟掉它。' },
    ],
  },
};

/** Where each briefing's stand-in mail servers listen, by its working directory. */
const servers = new Map<string, { imap: number; smtp: number; cal: string }>();

export const USE_CASES: readonly UseCase[] = [fixABug, research, writeInRelay, analyzeData, morningBriefing];

export function useCase(slug: string): UseCase {
  const found = USE_CASES.find((u) => u.slug === slug);
  if (!found) throw new Error(`No use case ${slug}: one of ${USE_CASES.map((u) => u.slug).join(', ')}`);
  return found;
}
