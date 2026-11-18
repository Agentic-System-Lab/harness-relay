/**
 * The twelve use cases the website shows (`site/use-cases/`), one for each kind of work, each recorded by
 * `npm run use-cases` with the real CLIs: what each one sets up, types and clicks, in both languages, and
 * the chapters of its rail. Every recording starts on a fresh server and in a fresh working directory
 * (`workspaces.ts`).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { chromium, type Locator } from 'playwright-core';
import type { ChatMessage, Conversation, ConversationSummary, Permission, Provider, TeamPlan } from '../../../src/shared/types';
import { en } from '../../../src/web/locales/en';
import { zhTW, type Messages } from '../../../src/web/locales/zh-TW';
import type { ChapterSpec } from '../chapters';
import type { DemoLang } from '../common';
import { api, firstRound, scrollCodeTo, sleep, type ApprovalPolicy, type Session } from '../recorder';
import {
  CALL_TITLE,
  COMPETITORS,
  ME,
  NEW_STRINGS,
  REP,
  SCREEN,
  addReminderStrings,
  bakeryBooks,
  bakeryNotes,
  billSplit,
  chapter,
  checkoutAlert,
  checkoutService,
  classNotes,
  competitorPage,
  fernwayStrings,
  interviews,
  invoices,
  launchBrief,
  productNotes,
  renewalCalendar,
  renewalCall,
  renewalMailbox,
  renewals,
  researchBrief,
  signupScreens,
  studioLaterMail,
  studioMailbox,
  vendorContract,
  writeAll,
  type Competitor,
} from './workspaces';

export const UI: Record<DemoLang, Messages> = { en, 'zh-TW': zhTW };

/** What a use case's recording is given: its working directory, and what its setup started. */
export interface Prepared {
  cwd: string;
  /** Files to attach to the question. */
  attach?: string[];
  /** Run once the recording is over (the stand-in servers stopped). */
  close?: () => Promise<void>;
  /** What the stand-in servers saw, for the review notes. */
  notes?: () => string[];
  /** What happens between two runs of an automation (new mail comes in). */
  later?: () => void;
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
  /** What is typed, per language: `question` (or an automation's `message`) is what the page quotes. */
  text: Record<DemoLang, Record<string, string>>;
  drive(s: Session, p: Prepared): Promise<string>;
  /** The chapter rail, per language. */
  rail: Record<DemoLang, ChapterSpec[]>;
  /**
   * Why it records on its own, after the others and one language at a time, when it must: a run of its
   * that shares something of the user's with any other recording's.
   */
  alone?: string;
}

const M = (s: Session) => UI[s.lang];
const NEW_CHAT = { hash: '#/new', ready: '.new-chat-page .preset-card' };
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A working directory made anew: the last recording's left nothing behind. */
function fresh(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
const idFromUrl = (url: string) => decodeURIComponent(/#\/c\/([^/?]+)/.exec(url)?.[1] ?? '');

/** Files to attach, written to an uploads folder of the use case's own beside its working directory: their paths. */
function uploads(cwd: string, files: Record<string, string | Buffer>): string[] {
  const dir = fresh(`${cwd}-uploads`);
  return Object.entries(files).map(([name, data]) => {
    const file = join(dir, name);
    writeFileSync(file, data);
    return file;
  });
}

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
    .nth(files.length - 1)
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  await sleep(1200);
  s.mark('attached', { files: files.length });
}

/** Replies a team gives before the run is over: everyone in relay mode, as each takes the file from the last. */
const allOf = (plan: TeamPlan | undefined) => plan?.agents?.length ?? 1;

/** Asks, then has the lead agent's team confirmed and its answers waited for (`replies` from its plan). */
async function askTeam(
  s: Session,
  id: string,
  question: string,
  o: { replies?: (plan: TeamPlan | undefined) => number; answer?: string } = {},
): Promise<TeamPlan | undefined> {
  await s.ask(question);
  s.mark('asked', { question });
  const plan = await s.designAndConfirm(id, 'q1', { poster: false });
  await s.waitAnswered(id, 'q1', (o.replies ?? firstRound)(plan), { answer: o.answer });
  await sleep(800);
  return plan;
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
  await moveClick(page.getByRole('button', { name: new RegExp(`^${re(M(s).chat.files)}$`) }), { after: 900 });
  await page.waitForSelector('.file-browser');
  for (const name of path) {
    await moveClick(page.locator('.file-list .file-name', { hasText: new RegExp(`^${re(name)}$`) }), { after: 800 });
  }
  await sleep(hold);
}

/** Scrolls the Files panel's rendered Markdown down slowly, as a person reads it. */
async function readMarkdown(s: Session, steps = 60): Promise<void> {
  await s.page.evaluate(async (n) => {
    const box = document.querySelector('.file-browser .preview-markdown');
    for (let i = 0; i < n && box; i++) {
      box.scrollTop += 5;
      await new Promise((r) => setTimeout(r, 16));
    }
  }, steps);
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

/** The first reply that changed this file. */
const changedBy = (c: Conversation, file: RegExp) =>
  c.messages.find((m) => m.changes?.some((ch) => ch.files.some((f) => file.test(f.path))));

/** The lead agent's review of the answers, at the end of the chat: scrolled to and read. */
async function showReview(s: Session): Promise<Locator | undefined> {
  const review = s.page.locator('.review-card').last();
  if (!(await review.count())) return undefined;
  await s.scrollToElement(review, 1600, 80);
  s.mark('review');
  await sleep(4500);
  await s.scrollMessages(500, 1600);
  await sleep(2500);
  return review;
}

/** On the New automation page: types the message (and a goal), sets when it runs, and creates it. Returns its chat. */
async function newAutomation(
  s: Session,
  o: {
    message: string;
    goal?: string;
    weekdaysAt?: string;
    /** When something happens: an event about to begin (this many minutes before, its title with these words), or a file changing. */
    calendar?: { minutes: number; title: string };
    file?: string;
    webhook?: boolean;
    newChat?: boolean;
    /** Ask, rather than refuse, what an agent wants beyond its permission in the runs it starts (someone is watching this one). */
    askUnwatched?: boolean;
    permission?: Permission;
    /** The chat's name, instead of the message's first line. */
    title?: string;
  },
): Promise<string> {
  const { page, moveClick, mark, typeSlow } = s;
  const T = M(s);
  await s.moveTo(700, 420, 300);
  await sleep(1000);
  // New automation, beside New chat.
  await moveClick(page.getByRole('button', { name: T.sidebar.newSchedule, exact: true }), { after: 900 });
  await page.waitForSelector('.new-chat-page .schedule-form');
  await sleep(1200);
  await moveClick(page.locator('.schedule-form textarea').first(), { after: 250 });
  await typeSlow(o.message, 22);
  await sleep(700);
  if (o.goal) {
    await moveClick(page.locator('.schedule-form textarea').nth(1), { after: 250 });
    await typeSlow(o.goal, 26);
    await sleep(900);
    mark('goal');
  }
  if (o.weekdaysAt) {
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
    await time.fill(o.weekdaysAt);
    await sleep(1200);
    mark('when', { repeat: 'weekly' });
  }
  if (o.calendar || o.file) {
    const w = T.schedule.watch;
    await moveClick(page.locator('.schedule-kinds button', { hasText: T.schedule.kinds.event }), { after: 900 });
    const trigger = page.locator('.schedule-form .schedule-trigger').first();
    const source = trigger.locator('.schedule-trigger-head select');
    await moveClick(source, { after: 300 });
    await source.selectOption(o.calendar ? 'calendar' : 'file');
    await sleep(900);
    const field = (label: string) => trigger.locator('label.field', { has: page.getByText(label, { exact: true }) }).locator('input');
    if (o.calendar) {
      // The calendar from Settings is picked by itself, the only one there.
      const minutes = field(w.minutes);
      await moveClick(minutes, { after: 200 });
      await minutes.fill(String(o.calendar.minutes));
      await sleep(600);
      await moveClick(field(w.title), { after: 200 });
      await typeSlow(o.calendar.title, 60);
    } else {
      await moveClick(field(w.pattern), { after: 200 });
      await typeSlow(o.file!, 60);
    }
    await sleep(1500);
    mark('when', { repeat: 'event', source: o.calendar ? 'calendar' : 'file' });
  }
  if (o.webhook) {
    await moveClick(page.locator('.schedule-form details.sub > summary', { hasText: T.schedule.hook.title }), { after: 700 });
    await moveClick(page.locator('.schedule-form label.check-row', { hasText: T.newSchedule.withHook }).locator('input'), { after: 700 });
    mark('webhook-on');
  }
  if (o.newChat) {
    await moveClick(page.locator('.schedule-form label.check-row', { hasText: T.schedule.newChat }).locator('input'), { after: 900 });
    mark('new-chat-each');
  }
  if (o.askUnwatched) {
    const approvals = page.getByRole('radiogroup', { name: T.schedule.approvals, exact: true });
    await moveClick(approvals.getByRole('radio', { name: T.schedule.approvalsAsk, exact: true }), { after: 900 });
    mark('ask-unwatched');
  }
  if (o.permission && o.permission !== 'read-only') {
    await moveClick(page.locator('.new-chat-page').getByRole('button', { name: T.permissions[o.permission].label, exact: true }), {
      after: 900,
    });
    mark('permission', { permission: o.permission });
  }
  // Without lead review: the automations' runs are read when they come.
  await page
    .locator('.lead-review input[type="checkbox"]')
    .uncheck()
    .catch(() => {});
  if (o.title) {
    await moveClick('.start-bar .title-input', { after: 200 });
    await typeSlow(o.title, 45);
    await sleep(600);
  }
  await moveClick('.start-bar .primary', { after: 900 });
  await page.waitForURL(/#\/c\//);
  const id = idFromUrl(page.url());
  s.log('conversation', id);
  mark('created');
  return id;
}

/** Opens the automation's drawer and clicks Run once now. */
async function runNow(s: Session, mark: string): Promise<void> {
  const { page, moveClick } = s;
  const T = M(s);
  s.mark(mark);
  await moveClick(page.getByRole('button', { name: new RegExp(`^${re(T.schedule.button)}$`) }), { after: 900 });
  await page.waitForSelector('.schedule-drawer');
  await sleep(1200);
  await moveClick(page.locator('.schedule-drawer').getByRole('button', { name: T.schedule.runNow }), { after: 1200 });
  await page.keyboard.press('Escape');
  await sleep(500);
}

/** Opens the automation's drawer and clicks Check now (an automation that waits for something), then closes it once checked. */
async function checkNow(s: Session, mark: string): Promise<void> {
  const { page, moveClick } = s;
  const T = M(s);
  await moveClick(page.getByRole('button', { name: new RegExp(`^${re(T.schedule.button)}$`) }), { after: 900 });
  await page.waitForSelector('.schedule-drawer');
  await sleep(1200);
  s.mark(mark);
  const button = page.locator('.schedule-drawer').getByRole('button', { name: T.schedule.watch.checkNow, exact: true });
  await moveClick(button, { after: 600 });
  // Checked once the button takes a click again.
  for (let i = 0; i < 60 && !(await button.isEnabled().catch(() => true)); i++) await sleep(500);
  await sleep(2500);
  await page.keyboard.press('Escape');
  await sleep(600);
}

/** Waits until the conversation's team is at work (an automation's run, started by a check). */
async function waitRunning(s: Session, id: string, limitMs = 120_000): Promise<boolean> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if ((await s.summary(id))?.running) return true;
    await sleep(500);
  }
  s.log(`WARNING: ${id} did not start in ${limitMs / 1000} s`);
  return false;
}

/** Waits for a conversation that was not there before (one an automation's run opened); its id. */
async function waitNewChat(s: Session, before: Set<string>, limitMs = 60_000): Promise<string> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const fresh = (await api<ConversationSummary[]>(s.base, '/api/conversations')).find((c) => !before.has(c.id));
    if (fresh) return fresh.id;
    await sleep(500);
  }
  throw new Error(`No new chat opened in ${limitMs / 1000} s`);
}

/** The first reply that changed this file, scrolled to: its diff opened and read, then closed. */
async function showDiff(s: Session, id: string, file: RegExp, mark: string): Promise<boolean> {
  const { page, moveClick } = s;
  const by = changedBy(await s.conversation(id), file);
  if (!by) {
    s.log(`WARNING: no reply changed ${file}`);
    return false;
  }
  const card = page.locator(`[id="msg-${by.id}"] .changes-card`).last();
  await s.scrollToElement(card, 1600, 160);
  await sleep(1000);
  s.mark(mark, { agent: by.agentName, provider: by.provider });
  await moveClick(card.getByRole('button', { name: M(s).changes.turnDiff }), { after: 1200 });
  await sleep(5000);
  await page.keyboard.press('Escape');
  await sleep(900);
  return true;
}

/** Sends what waits in the outbox, each card as it is shown; how many went. */
async function sendOutbox(s: Session, max: number): Promise<number> {
  const { page, moveClick, mark } = s;
  const pending = page.locator('.outbox-card.outbox-pending');
  const count = await pending.count();
  if (!count) return 0;
  await s.scrollToElement(pending.first(), 1600, 120);
  mark('outbox', { items: count });
  await sleep(3500);
  let sent = 0;
  for (; sent < Math.min(max, count); sent++) {
    const card = page.locator('.outbox-card.outbox-pending').first();
    if (!(await card.count())) break;
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await moveClick(card.getByRole('button', { name: M(s).outbox.send, exact: true }), { after: 1500 });
  }
  mark('sent', { sent });
  await sleep(2500);
  return sent;
}

// --- 1. Software engineer: fix a bug three ways ---------------------------------------------------

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
  start: NEW_CHAT,
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

// --- 2. Product manager: from interviews to a spec ------------------------------------------------

const productSpec: UseCase = {
  slug: 'product-spec',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 80,
  poster: { at: 'files', offset: 4, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'shiftbell'));
    writeAll(cwd, productNotes(lang));
    return { cwd, attach: uploads(cwd, interviews(lang)) };
  },
  start: NEW_CHAT,
  text: {
    en: {
      question:
        'Attached are five customer interviews; PRODUCT.md says who our customers are. Write a one-page PRD for next quarter’s feature in PRD.md, as a relay: Claude Code pulls out the pain points with quotes, Codex writes the PRD, Grok challenges its assumptions. Before anyone writes the PRD, ask me which customers to build for first.',
      answer: 'Restaurants and cafés first: they are 141 of our 182 customers, and they leave four times as often as clinics.',
    },
    'zh-TW': {
      question:
        '附件是五份客戶訪談，PRODUCT.md 寫了我們的客戶是誰。請用接力的方式，為下一季的功能寫一頁 PRD，存成 PRD.md：Claude Code 整理痛點並附上原話，Codex 寫 PRD，Grok 挑戰其中的假設。寫 PRD 之前，先問我要先為哪一群客戶做。',
      answer: '先做餐廳和咖啡店：182 家客戶裡有 141 家是他們，而且他們流失的比例是診所的四倍。',
    },
  },
  async drive(s, p) {
    const { mark } = s;
    const id = await startChat(s, { permission: 'edit', leadReview: false });
    await attach(s, p.attach ?? []);
    await askTeam(s, id, this.text[s.lang]!.question!, { replies: allOf, answer: this.text[s.lang]!.answer });
    await readBack(s, 1800);
    mark('q1-read');
    const prd = changedFile(await s.conversation(id), /PRD\.md$/i) ?? 'PRD.md';
    mark('files', { file: prd });
    await openFile(s, prd.split('/'), 3000);
    await readMarkdown(s, 80);
    await sleep(2500);
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation with Edit, so the agents may write the PRD.' },
      { at: 'attached', kind: 'you', say: 'Attach the five customer interviews, and ask for a one-page PRD, as a relay.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, in relay, and says why.' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: 'The first reads the interviews and pulls out each pain point with its quote.' },
      { at: 'asked-user', kind: 'agent', say: 'Stops to ask you which customers to build for first, as you said it should.' },
      { at: 'answered-user', kind: 'you', say: 'Answer in the message box: restaurants and cafés first, and why.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'The PRD is written for your answer, then challenged assumption by assumption.' },
      { at: 'files', kind: 'you', say: 'Open PRD.md in Files, rendered as it will read.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限選「可編輯」，agent 才能寫 PRD。' },
      { at: 'attached', kind: 'you', say: '附上五份客戶訪談，請他們用接力的方式寫一頁 PRD。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，以接力進行，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '第一位讀完訪談，整理出每個痛點和客戶的原話。' },
      { at: 'asked-user', kind: 'agent', say: '依你的要求停下來問你：要先為哪一群客戶做。' },
      { at: 'answered-user', kind: 'you', say: '在訊息框回答：先做餐廳和咖啡店，並說明原因。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '依你的回答寫出 PRD，再逐一挑戰其中的假設。' },
      { at: 'files', kind: 'you', say: '在「檔案」打開 PRD.md，看排版後的樣子。' },
    ],
  },
};

// --- 3. Marketer: read the competitors' pages, write the launch copy ------------------------------

const launchCopy: UseCase = {
  slug: 'launch-copy',
  providers: ['claude', 'codex'],
  approvals: 'allow',
  length: 85,
  poster: { at: 'q1-answered', offset: 2, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'plotline'));
    // The competitors' pricing pages, each under a name of its own on this computer (name.localhost).
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0]!.replace(/\.localhost$/, '') as Competitor;
      seen.push(`${host}${req.url}`);
      if (!COMPETITORS.includes(host) || !/^\/(pricing\/?)?(\?.*)?$/.test(req.url ?? '')) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(competitorPage(lang, host));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    writeAll(cwd, launchBrief(lang, port));
    return {
      cwd,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      notes: () => [`The stand-in web server served: ${[...new Set(seen)].join(', ') || 'nothing'}`],
    };
  },
  async setup(base) {
    await api(base, '/api/tools', { relayTools: { browser: ['claude', 'codex'] } }, 'PUT');
  },
  start: NEW_CHAT,
  text: {
    en: {
      question:
        'Our Studio plan launches on 1 December; LAUNCH.md says what it does and costs. With Harness Relay’s browser, Claude Code and Codex read the three competitors’ pricing pages listed there, then take turns on three taglines and a 100-word launch post that say what we do that they don’t.',
      followUp: 'Now the Instagram version of the launch post: playful, under 60 words, three hashtags, for podcasters just starting out.',
    },
    'zh-TW': {
      question:
        '我們的 Studio 方案 12 月 1 日上市，LAUNCH.md 寫了它的功能和價格。請 Claude Code 和 Codex 用 Harness Relay 的瀏覽器讀完裡面列的三個競品價格頁，再輪流寫出三句標語和一篇 150 字的上市貼文，說出我們有、他們沒有的地方。',
      followUp: '再寫一版 Instagram 用的上市貼文：輕鬆有趣、80 字以內、三個 hashtag，給剛開始做 podcast 的人看。',
    },
  },
  async drive(s) {
    const { page, moveClick, mark } = s;
    const T = M(s);
    const id = await startChat(s, { permission: 'read-only', leadReview: false });
    await askTeam(s, id, this.text[s.lang]!.question!);
    await readBack(s, 1800);
    mark('q1-read');

    // Branch from the last reply, to try another voice without losing this one.
    const c = await s.conversation(id);
    const last = [...c.messages].reverse().find((m) => m.author.kind === 'agent' && m.status === 'done');
    if (!last) {
      s.log('WARNING: no finished reply to branch from');
      return id;
    }
    const reply = page.locator(`[id="msg-${last.id}"]`);
    await s.scrollToElement(reply, 1400, 60);
    await sleep(800);
    mark('branch');
    await moveClick(reply.getByRole('button', { name: T.message.branch, exact: true }).last(), { after: 600 });
    await page.waitForURL((u) => /#\/c\//.test(u.hash) && idFromUrl(u.href) !== id, { timeout: 30_000 });
    const branch = idFromUrl(page.url());
    s.log('branch', branch);
    await sleep(1800);
    mark('branched');
    const before = s.agentReplies(await s.conversation(branch));
    await s.ask(this.text[s.lang]!.followUp!);
    mark('asked-2');
    const plan = await s.designAndConfirm(branch, 'q2', { poster: false });
    await s.waitAnswered(branch, 'q2', before + firstRound(plan));
    await sleep(800);
    await s.scrollMessages(-900, 2200);
    await sleep(1400);
    await s.scrollMessages(4000, 1500);
    mark('q2-read');
    // The branch sits under the conversation it came from, in the sidebar.
    await s.moveTo(150, 260, 900);
    mark('sidebar');
    await sleep(3000);
    return branch;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation, read-only: the agents only read pages and write in the chat.' },
      { at: 'chat-open', kind: 'you', say: 'Ask for three taglines and a launch post, from the competitors’ pricing pages.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, {rounds}, and says why.' },
      {
        at: 'q1-confirmed',
        kind: 'team',
        team: 'q1',
        say: 'They open each pricing page in Harness Relay’s own browser and read it, then write in turn.',
      },
      { at: 'approval', kind: 'agent', say: 'Asks before the browser opens a site it has not opened before: you allow it.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'Three taglines and a launch post, each claim set against a competitor’s plan.' },
      { at: 'branch', kind: 'you', say: 'Branch from the last reply: a new conversation to try another voice, this one kept.' },
      { at: 'asked-2', kind: 'you', say: 'Ask the branch for a playful Instagram version.' },
      { at: 'q2-answered', kind: 'team', team: 'q2', say: 'The Instagram post, written from what the first conversation found.' },
      { at: 'sidebar', kind: 'you', say: 'In the sidebar the branch sits under the conversation it came from.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限維持唯讀：agent 只讀網頁、在對話裡寫。' },
      { at: 'chat-open', kind: 'you', say: '請他們根據競品的價格頁，寫三句標語和一篇上市貼文。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，{rounds}，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '他們用 Harness Relay 自己的瀏覽器打開每個價格頁讀完，再輪流寫。' },
      { at: 'approval', kind: 'agent', say: '瀏覽器要開沒開過的網站之前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '三句標語和一篇上市貼文，每個賣點都對照了競品的方案。' },
      { at: 'branch', kind: 'you', say: '從最後一則回覆分支：開一段新對話試另一種語氣，原本的保留不動。' },
      { at: 'asked-2', kind: 'you', say: '在分支裡要一版輕鬆的 Instagram 貼文。' },
      { at: 'q2-answered', kind: 'team', team: 'q2', say: 'Instagram 貼文，根據第一段對話查到的內容寫成。' },
      { at: 'sidebar', kind: 'you', say: '側邊欄裡，分支就列在它分出來的對話底下。' },
    ],
  },
};

// --- 4. Accountant: close the month, two pairs of eyes --------------------------------------------

const reconcile: UseCase = {
  slug: 'reconcile-accounts',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 75,
  poster: { at: 'review', offset: 2, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'harbor-bakery'));
    writeAll(cwd, bakeryNotes(lang));
    return { cwd, attach: uploads(cwd, bakeryBooks(lang)) };
  },
  start: NEW_CHAT,
  text: {
    en: {
      question:
        'Close October for Harbor Bakery: reconcile the attached bank statement against the cash ledger. Have Claude Code, Codex and Grok each reconcile it on their own, then list every difference with its amount, whether it is a timing difference or an error, and the entry that fixes it.',
    },
    'zh-TW': {
      question:
        '幫港邊烘焙坊做 10 月的月結：把附件的銀行對帳單和現金帳對起來。請 Claude Code、Codex 和 Grok 各自獨立對帳，再列出每一筆差異：金額、是時間差還是錯誤，以及要做的調整分錄。',
    },
  },
  async drive(s, p) {
    const id = await startChat(s, { permission: 'read-only', leadReview: true });
    await attach(s, p.attach ?? []);
    await askTeam(s, id, this.text[s.lang]!.question!);
    await readBack(s, 2200);
    s.mark('q1-read');
    await showReview(s);
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation, read-only, with lead review on.' },
      { at: 'attached', kind: 'you', say: 'Attach the bank statement and the cash ledger, and ask for October’s reconciliation.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, each on its own, and says why.' },
      {
        at: 'q1-confirmed',
        kind: 'team',
        team: 'q1',
        say: 'Each matches the two files line by line with scripts of its own, without seeing the others.',
      },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command read-only does not cover by itself: you allow it.' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: 'Three reconciliations: each difference, timing or error, and its adjusting entry.',
      },
      {
        at: 'review',
        kind: 'lead',
        team: 'q1',
        say: 'Reviews the three: the same differences found, the balances re-checked, and what to confirm yourself.',
      },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限維持唯讀，首席 agent 審閱保持開啟。' },
      { at: 'attached', kind: 'you', say: '附上銀行對帳單和現金帳，請他們做 10 月的銀行調節。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，各自處理，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '每位自己寫程式逐筆比對兩份檔案，看不到其他人的結果。' },
      { at: 'approval', kind: 'agent', say: '要執行唯讀權限本身不涵蓋的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '三份調節表：每筆差異、是時間差還是錯誤，以及調整分錄。' },
      { at: 'review', kind: 'lead', team: 'q1', say: '審閱三份結果：找到的差異相同、重算餘額，並列出該由你親自確認的事。' },
    ],
  },
};

// --- 5. Business owner: follow up on overdue invoices until they are settled ----------------------

/** Where each run's stand-in mail servers listen, by its working directory. */
const mailServers = new Map<string, { imap: number; smtp: number }>();

const collectPayments: UseCase = {
  slug: 'collect-payments',
  providers: ['claude', 'codex'],
  approvals: 'allow',
  length: 90,
  poster: { at: 'progress', offset: 1.5, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'studio'));
    writeAll(cwd, invoices(lang));
    const { fakeImap, fakeSmtp } = await import('../../../test/fake-mail-servers');
    const login = { user: ME.user, pass: ME.pass };
    const messages = studioMailbox(lang);
    const imap = await fakeImap(messages, login);
    const smtp = await fakeSmtp(login);
    mailServers.set(cwd, { imap: imap.port, smtp: smtp.port });
    return {
      cwd,
      // The mail that comes in before the next run: the stand-in server serves the same list.
      later: () => messages.push(...studioLaterMail(lang)),
      close: async () => {
        await Promise.all([imap.close(), smtp.close()]);
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
    const at = mailServers.get(p.cwd)!;
    await api(
      base,
      '/api/connectors/mail/work',
      {
        name: lang === 'en' ? 'Studio' : '工作室',
        address: `${ME.name} <${ME.address}>`,
        username: ME.user,
        password: ME.pass,
        imap: { host: '127.0.0.1', port: at.imap, security: 'none' },
        smtp: { host: '127.0.0.1', port: at.smtp, security: 'none' },
      },
      'PUT',
    );
    await api(base, '/api/tools', { relayTools: { mail: ['claude', 'codex'] } }, 'PUT');
  },
  start: NEW_CHAT,
  text: {
    en: {
      message:
        'Every weekday at 09:00, with Harness Relay’s mail tools: check the mail since the last run for payments and replies about the overdue invoices in INVOICES.md. Write each client whose invoice is still unpaid, with no date agreed, a short and friendly reminder with mail_send; answer any client who proposed a plan, agreeing to it. Each mail waits in my outbox until I press Send. Claude Code reads the mail, Codex keeps the tally against INVOICES.md.',
      goal: 'Each overdue invoice in INVOICES.md is paid in full, or its client agreed in writing to a date to pay it.',
    },
    'zh-TW': {
      message:
        '每個工作日 09:00，用 Harness Relay 的郵件工具：從上次執行以來的信裡，找 INVOICES.md 裡逾期發票的入帳通知和客戶回覆。還沒付款、也還沒約好日期的客戶，用 mail_send 寫一封簡短友善的提醒；有客戶提出付款方式的，回信同意。每封信都在我的待送出匣等我按「送出」。Claude Code 讀信，Codex 對照 INVOICES.md 記帳。',
      goal: 'INVOICES.md 裡的每張逾期發票都已經付清，或是客戶已經用書面同意了付款的日期。',
    },
  },
  async drive(s, p) {
    const { page, moveClick, mark } = s;
    const T = M(s);
    const id = await newAutomation(s, { message: this.text[s.lang]!.message!, goal: this.text[s.lang]!.goal!, weekdaysAt: '09:00' });
    // The lead agent designs the team for the message; nothing runs until it is due, or run now.
    const plan = await s.designAndConfirm(id, 'q1');
    await sleep(800);
    await runNow(s, 'run-now');
    await s.waitAnswered(id, 'q1', firstRound(plan));
    await sleep(800);
    await readBack(s, 1600);
    mark('q1-read');
    await sendOutbox(s, 3);

    // The next morning: a payment and a promise came in. The second run reads them.
    p.later?.();
    mark('next-day');
    const before = s.agentReplies(await s.conversation(id));
    await runNow(s, 'run-again');
    await s.waitAnswered(id, 'q2', before + firstRound(plan));
    await sleep(800);
    await s.scrollMessages(-1200, 2400);
    await sleep(1400);
    await s.scrollMessages(4000, 1500);
    mark('q2-read');

    // What the automation keeps of the goal, run by run.
    await moveClick(page.getByRole('button', { name: new RegExp(`^${re(T.schedule.button)}$`) }), { after: 900 });
    const progress = page.locator('.schedule-drawer .schedule-progress');
    if (await progress.count()) {
      await progress.scrollIntoViewIfNeeded().catch(() => {});
      mark('progress');
      await sleep(5000);
    }
    await page.keyboard.press('Escape');
    await sleep(800);
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'New automation: what to send the team every weekday at 09:00, read-only.' },
      { at: 'goal', kind: 'you', say: 'And the goal to track: every overdue invoice paid, or a date agreed in writing.' },
      { at: 'created', kind: 'you', say: 'Create it: a conversation opens for it, and nothing runs yet.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: 'Designs the team for the message: {names}, and says why.' },
      { at: 'run-now', kind: 'you', say: 'Run once now, to try it before its first morning.' },
      {
        at: 'q1-answering',
        kind: 'team',
        team: 'q1',
        say: 'They read the mail with Harness Relay’s mail tools and tally it against the invoices.',
      },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: 'One invoice paid, one client asking to pay in two parts, one with no word yet.',
      },
      { at: 'outbox', kind: 'you', say: 'Their mails wait in the outbox: you read each one, then send it from your account.' },
      { at: 'next-day', kind: 'you', say: 'The next morning a payment and a promised date have come in. Run it again.' },
      {
        at: 'q2-answered',
        kind: 'team',
        team: 'q1',
        say: 'They read the new mail, knowing what the last run found: nothing left to chase.',
      },
      { at: 'progress', kind: 'you', say: 'The automation’s progress, run by run: the goal is reached.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '新自動任務：每個工作日 09:00 要交給團隊的事，權限唯讀。' },
      { at: 'goal', kind: 'you', say: '再寫上要追蹤的目標：每張逾期發票都付清，或已書面約好日期。' },
      { at: 'created', kind: 'you', say: '建立後會開一段它的對話，這時還不會執行。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '為這則訊息設計團隊：{names}，並說明原因。' },
      { at: 'run-now', kind: 'you', say: '按「立即執行一次」，在第一個早上之前先試跑。' },
      { at: 'q1-answering', kind: 'team', team: 'q1', say: '他們用 Harness Relay 的郵件工具讀信，對照發票記帳。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '一張已付款，一位客戶想分兩期，一位還沒消息。' },
      { at: 'outbox', kind: 'you', say: '他們寫的信都在待送出匣：你一封封看過，再用自己的帳號寄出。' },
      { at: 'next-day', kind: 'you', say: '隔天早上，來了一筆款項和一個約好的付款日。再執行一次。' },
      { at: 'q2-answered', kind: 'team', team: 'q1', say: '他們讀新來的信，也知道上次查到什麼：已經沒有要追的了。' },
      { at: 'progress', kind: 'you', say: '自動任務每次執行的進度：目標已達成。' },
    ],
  },
};

// --- 6. Account manager: a brief before each customer call ----------------------------------------

/** Where each run's stand-in mail servers and calendar are, by its working directory. */
const renewalServers = new Map<string, { imap: number; smtp: number; calendar: string }>();

const callBrief: UseCase = {
  slug: 'call-brief',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 85,
  poster: { at: 'q1-answered', offset: 2, fallback: 'opened' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'renewals'));
    writeAll(cwd, renewals(lang));
    const { fakeCalDav, fakeImap, fakeSmtp } = await import('../../../test/fake-mail-servers');
    const login = { user: REP.user, pass: REP.pass };
    const events = renewalCalendar(lang);
    const [imap, smtp, calendar] = await Promise.all([fakeImap(renewalMailbox(lang), login), fakeSmtp(login), fakeCalDav(events, login)]);
    renewalServers.set(cwd, { imap: imap.port, smtp: smtp.port, calendar: calendar.url });
    return {
      cwd,
      // The renewal call comes within half an hour: the stand-in calendar serves the same list.
      later: () => events.push(renewalCall(lang)),
      close: async () => {
        await Promise.all([imap.close(), smtp.close(), calendar.close()]);
      },
      notes: () => [
        `The stand-in calendar answered ${calendar.reports.length} report(s); events written: ${calendar.puts.length}`,
        ...smtp.sent.map((m) => `Sent through the stand-in SMTP server to ${m.to.join(', ')}`),
      ],
    };
  },
  async setup(base, p, lang) {
    const at = renewalServers.get(p.cwd)!;
    await api(
      base,
      '/api/connectors/mail/work',
      {
        name: 'Brightdesk',
        address: `${REP.name} <${REP.address}>`,
        username: REP.user,
        password: REP.pass,
        imap: { host: '127.0.0.1', port: at.imap, security: 'none' },
        smtp: { host: '127.0.0.1', port: at.smtp, security: 'none' },
      },
      'PUT',
    );
    await api(
      base,
      '/api/connectors/calendar/work',
      { name: lang === 'en' ? 'Work' : '工作', url: at.calendar, username: REP.user, password: REP.pass },
      'PUT',
    );
    // Grok has Harness Relay's tools in full access only: it argues from what the others found.
    await api(base, '/api/tools', { relayTools: { mail: ['claude', 'codex'], calendar: ['claude', 'codex'] } }, 'PUT');
  },
  start: NEW_CHAT,
  text: {
    en: {
      message:
        'Thirty minutes before each customer call on my calendar: with Harness Relay’s calendar and mail tools, see who is coming, the notes of our last meeting with them and our latest mail with them; then read their notes and weekly usage in accounts/, and PRICING.md. Give me a one-page brief: what they asked for last time, how their usage is trending, the three hardest questions they are likely to ask, each with an answer PRICING.md allows, and the one thing to ask for on this call. Claude Code reads the calendar and the mail, Codex works out the usage numbers, and Grok plays their CFO in the second round and asks the hard questions.',
    },
    'zh-TW': {
      message:
        '行事曆上每場客戶會議開始前 30 分鐘：用 Harness Relay 的行事曆和郵件工具，看這場有誰參加、我們和他們上次開會的紀錄，以及最近和他們往來的信；再讀 accounts/ 裡這家客戶的筆記和每週使用量，以及 PRICING.md。給我一頁會前簡報：他們上次要什麼、使用量怎麼走、他們最可能問的三個難題，每題附上 PRICING.md 允許的回答，以及這場會議我該爭取的一件事。Claude Code 讀行事曆和信，Codex 算使用量，Grok 在第二輪扮演他們的財務長，提出難題。',
    },
  },
  async drive(s, p) {
    const { page, moveClick, mark } = s;
    const id = await newAutomation(s, {
      message: this.text[s.lang]!.message!,
      calendar: { minutes: 30, title: CALL_TITLE[s.lang] },
      newChat: true,
      title: s.lang === 'en' ? 'Customer call briefs' : '客戶會議簡報',
    });
    const plan = await s.designAndConfirm(id, 'q1');
    await sleep(1500);
    // The first check only notes the events about to begin then: an internal meeting, no customer call.
    await checkNow(s, 'first-check');
    // Later that day: the renewal call is less than half an hour away.
    p.later?.();
    mark('call-soon');
    const before = new Set((await api<ConversationSummary[]>(s.base, '/api/conversations')).map((c) => c.id));
    await checkNow(s, 'check-now');
    // The check starts a new chat for the call, with the event as data: opened from the sidebar.
    const chat = await waitNewChat(s, before);
    s.log('call chat', chat);
    await sleep(1500);
    await moveClick(page.locator(`.conv-item a.conv-link[href="#/c/${chat}"]`), { after: 1200 });
    await page.waitForURL((u) => idFromUrl(u.href) === chat, { timeout: 15_000 }).catch(() => {});
    mark('opened');
    await sleep(1500);
    // What the check found goes with the message as data: the event, opened.
    const event = page.locator('details.event-block > summary').first();
    if (await event.count()) {
      await moveClick(event, { after: 600 });
      mark('event');
      await sleep(4000);
      await moveClick(event, { after: 600 });
    }
    await s.waitAnswered(chat, 'q1', firstRound(plan));
    await sleep(800);
    await readBack(s, 2000);
    mark('q1-read');
    return chat;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'New automation: what to hand the team before each customer call, read-only.' },
      { at: 'when', kind: 'you', say: 'It waits for the calendar: 30 minutes before each event whose title has “Customer call”.' },
      { at: 'new-chat-each', kind: 'you', say: 'A new chat for each call, so that each brief starts afresh.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: 'Designs the team for the message: {names}, {rounds} of roundtable, and says why.' },
      { at: 'first-check', kind: 'you', say: 'Check now: the first check only notes what is about to begin, so nothing starts.' },
      { at: 'call-soon', kind: 'you', say: 'Later: the renewal call with Harbor & Pine is less than half an hour away. Check again.' },
      { at: 'opened', kind: 'you', say: 'The check finds the call and starts a new chat for it: open it from the sidebar.' },
      { at: 'event', kind: 'you', say: 'The event goes with the message as data: its title, time, place and attendees.' },
      {
        at: 'q1-answering',
        kind: 'team',
        team: 'q1',
        say: 'They read the last meeting’s notes and the mail with Harness Relay’s tools, then the notes and the usage.',
      },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command read-only does not cover by itself: you allow it.' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: 'Their CFO asks the three hardest questions, the brief answers each from PRICING.md, and the CFO flags one answer that goes beyond it.',
      },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '新自動任務：每場客戶會議之前要交給團隊的事，權限唯讀。' },
      { at: 'when', kind: 'you', say: '它等行事曆：標題有「客戶會議」的活動，開始前 30 分鐘。' },
      { at: 'new-chat-each', kind: 'you', say: '每場會議都開新對話，每份簡報都從頭開始。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '為這則訊息設計團隊：{names}，以接力進行，並說明原因。' },
      { at: 'first-check', kind: 'you', say: '按「立即檢查」：第一次檢查只記下快開始的活動，不會啟動。' },
      { at: 'call-soon', kind: 'you', say: '稍後：和港松診所的續約會議不到半小時就要開始。再檢查一次。' },
      { at: 'opened', kind: 'you', say: '檢查找到這場會議，為它開一段新對話：從側邊欄打開。' },
      { at: 'event', kind: 'you', say: '活動隨訊息當作資料交給團隊：標題、時間、地點和與會者。' },
      {
        at: 'q1-answering',
        kind: 'team',
        team: 'q1',
        say: '他們用 Harness Relay 的工具讀上次會議的紀錄和往來的信，再讀筆記和使用量。',
      },
      { at: 'approval', kind: 'agent', say: '要執行唯讀權限本身不涵蓋的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '他們的財務長提出最難的問題；簡報依 PRICING.md 一一回答。' },
    ],
  },
};

// --- 7. Researcher: what the studies say, with sources --------------------------------------------

const literatureReview: UseCase = {
  slug: 'literature-review',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 75,
  poster: { at: 'review', offset: 2, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'four-day-week'));
    writeAll(cwd, researchBrief(lang));
    return { cwd };
  },
  start: NEW_CHAT,
  text: {
    en: {
      question:
        'Read BRIEF.md. What does the research say about four-day weeks: output, burnout and teams that serve customers every day? Have Claude Code, Codex and Grok each find the trials and studies themselves, debate how strong the evidence is, and give leadership a one-page summary with a link to every source.',
    },
    'zh-TW': {
      question:
        '先讀 BRIEF.md。關於四天工作週的產出、過勞，以及每天服務客戶的團隊，研究怎麼說？請 Claude Code、Codex 和 Grok 各自找試行計畫和研究，辯論證據有多可靠，再給主管一頁摘要，每個來源都附上連結。',
    },
  },
  async drive(s) {
    const { moveClick, mark } = s;
    const id = await startChat(s, { permission: 'read-only', leadReview: true });
    await askTeam(s, id, this.text[s.lang]!.question!);
    await readBack(s, 2200);
    mark('q1-read');
    const review = await showReview(s);
    // From a point in the review to the words it quotes, marked in the reply.
    const link = review?.locator('.review-reply-link').first();
    if (link && (await link.count())) {
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(600);
      mark('jump');
      await moveClick(link, { after: 1200 });
      await sleep(3500);
    }
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation, read-only, with lead review on.' },
      { at: 'chat-open', kind: 'you', say: 'Ask what the research says about four-day weeks, with a link to every source.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, {rounds}, and says why.' },
      {
        at: 'q1-confirmed',
        kind: 'team',
        team: 'q1',
        say: 'Each searches the web and reads the studies, then answers the others’ points.',
      },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command read-only does not cover by itself: you allow it.' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: 'One summary for leadership: what holds up, what is thin, and the links they read.',
      },
      { at: 'review', kind: 'lead', team: 'q1', say: 'Reviews the replies: where they disagree, and which claims to check yourself.' },
      { at: 'jump', kind: 'you', say: 'Click a point of the review: the reply opens at the words it quotes, marked.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限維持唯讀，首席 agent 審閱保持開啟。' },
      { at: 'chat-open', kind: 'you', say: '提問：四天工作週的研究怎麼說？每個來源都要附連結。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，{rounds}，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '每位上網搜尋、讀研究，再回應其他人的論點。' },
      { at: 'approval', kind: 'agent', say: '要執行唯讀權限本身不涵蓋的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '給主管的一頁摘要：哪些證據站得住、哪些還薄弱，附上他們讀過的連結。' },
      { at: 'review', kind: 'lead', team: 'q1', say: '審閱回覆：哪裡意見不同、哪些說法該由你親自確認。' },
      { at: 'jump', kind: 'you', say: '點審閱裡的一點：回覆隨即捲到它引用的文字，並標示出來。' },
    ],
  },
};

// --- 8. Teacher: a quiz, tried out on a student first ---------------------------------------------

const writeAQuiz: UseCase = {
  slug: 'write-a-quiz',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 80,
  poster: { at: 'files', offset: 4, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'class-8b'));
    writeAll(cwd, classNotes(lang));
    return { cwd, attach: uploads(cwd, chapter(lang)) };
  },
  start: NEW_CHAT,
  text: {
    en: {
      question:
        'Attached is chapter 5 for my grade 8 class. Make a 10-question quiz from it, as a relay: Claude Code writes quiz.md (4 easy, 4 medium, 2 hard) and answer-key.md; Grok takes the quiz as a student would, without opening the answer key; Codex marks Grok’s answers and sends any question a student could misread back to Claude Code to rewrite.',
    },
    'zh-TW': {
      question:
        '附件是我八年級班上的第五章。請用接力的方式出一份 10 題的小考：Claude Code 寫 quiz.md（4 題簡單、4 題中等、2 題難）和 answer-key.md；Grok 像學生一樣作答，不打開解答；Codex 批改 Grok 的答案，學生可能誤解的題目退回給 Claude Code 改寫。',
    },
  },
  async drive(s, p) {
    const { page, moveClick, mark } = s;
    const id = await startChat(s, { permission: 'edit', leadReview: false });
    await attach(s, p.attach ?? []);
    await askTeam(s, id, this.text[s.lang]!.question!, { replies: allOf });
    await readBack(s, 1800);
    mark('q1-read');
    const quiz = changedFile(await s.conversation(id), /quiz\.md$/i) ?? 'quiz.md';
    mark('files', { file: quiz });
    await openFile(s, quiz.split('/'), 3000);
    await readMarkdown(s, 90);
    await sleep(1500);
    // The whole folder, quiz and answer key, as one ZIP file.
    const zip = page.getByRole('button', { name: new RegExp(`^${re(M(s).files.downloadFolder('\u0000')).replace('\u0000', '.+')}$`) });
    if (await zip.count()) {
      mark('zip');
      await moveClick(zip.first(), { after: 2500 });
    }
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation with Edit, so the agents may write the quiz and its key.' },
      { at: 'attached', kind: 'you', say: 'Attach the chapter, and ask for a 10-question quiz, tried on a student first.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, in relay, and says why.' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: 'One writes the quiz, one takes it as a student would, one marks it.' },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command its permission does not cover: you allow it.' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: 'The student scores full marks and the marker finds no question to misread, so nothing goes back; each lists its files.',
      },
      { at: 'files', kind: 'you', say: 'Open quiz.md in Files, rendered as the class will read it.' },
      { at: 'zip', kind: 'you', say: 'Download the folder as a ZIP file: the quiz and its answer key together.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限選「可編輯」，agent 才能寫考卷和解答。' },
      { at: 'attached', kind: 'you', say: '附上課文，請他們出一份 10 題的小考，先讓「學生」試考。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，以接力進行，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '一位出題、一位像學生一樣作答、一位批改。' },
      { at: 'approval', kind: 'agent', say: '要執行權限之外的指令前先問你：你選擇允許。' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: '學生拿到滿分，批改也沒找到會讓人誤解的題目，所以沒有退回；每則回覆都列出它的檔案。',
      },
      { at: 'files', kind: 'you', say: '在「檔案」打開 quiz.md，看學生拿到時的樣子。' },
      { at: 'zip', kind: 'you', say: '把資料夾下載成 ZIP 檔：考卷和解答一起帶走。' },
    ],
  },
};

// --- 9. Lawyer: redline a contract on your own model server -------------------------------------

/**
 * The model server the contract review runs on, every agent and the lead agent: an OpenAI-compatible
 * endpoint of the user's own (vLLM), named by the environment, so that its address and key are never in
 * the repository. USE_CASES_ENDPOINT_URL (such as `http://homelab:8000/v1`), USE_CASES_ENDPOINT_MODEL (as
 * the server serves it) and USE_CASES_ENDPOINT_KEY (when it needs one).
 */
export const ENDPOINT = {
  id: 'homelab',
  model: () => process.env.USE_CASES_ENDPOINT_MODEL || 'qwen3.8-27b-nvfp4-unsloth',
  /** A member's model on it, as Harness Relay names it. */
  member: () => `homelab/${ENDPOINT.model()}`,
};

const contractReview: UseCase = {
  slug: 'contract-review',
  providers: ['claude', 'codex', 'grok'],
  // Grok on an endpoint has it in its own config.toml, in your Grok home, which every Grok run (another
  // recording's, without endpoints, takes it out) writes: two at once would each see the other's change.
  alone: 'Grok’s own config.toml holds the endpoint’s model while it runs',
  approvals: 'allow',
  length: 85,
  poster: { at: 'redline', offset: 2.4, fallback: 'q1-answered' },
  async prepare(lang, root) {
    if (!process.env.USE_CASES_ENDPOINT_URL)
      throw new Error('contract-review runs on your own model server: set USE_CASES_ENDPOINT_URL (and _MODEL, _KEY)');
    const cwd = fresh(join(root, 'vendor-contract'));
    vendorContract(cwd, lang);
    return { cwd };
  },
  async setup(base, _p, lang) {
    await api(
      base,
      `/api/backends/endpoints/${ENDPOINT.id}`,
      {
        name: lang === 'en' ? 'Homelab vLLM' : '自家 vLLM',
        baseUrl: process.env.USE_CASES_ENDPOINT_URL,
        models: [ENDPOINT.model()],
        ...(process.env.USE_CASES_ENDPOINT_KEY ? { apiKey: process.env.USE_CASES_ENDPOINT_KEY } : {}),
      },
      'PUT',
    );
    // Every member on it by default, and the lead agent too: nothing of the contract goes to anyone's cloud.
    for (const p of this.providers)
      await api(base, `/api/settings/providers/${p}/accounts/default`, { defaultModel: ENDPOINT.member() }, 'PUT');
    await api(base, '/api/settings', { lead: { provider: 'claude', model: ENDPOINT.member() } }, 'PUT');
  },
  start: { hash: '#/settings/backends', ready: '#settings-backends' },
  text: {
    en: {
      question: `Redline contract.md against our playbook.md, as a relay: Claude Code edits each clause that departs from the playbook, right in contract.md; Codex checks every edit against the playbook and the original wording; Grok writes REDLINE-MEMO.md: each change, the rule behind it, and what to tell the vendor. The contract is confidential: every member runs on ${ENDPOINT.member()}, our own vLLM server.`,
    },
    'zh-TW': {
      question: `依我們的 playbook.md 修訂 contract.md，用接力的方式：Claude Code 直接在 contract.md 裡改掉每一條偏離準則的條款；Codex 對照準則和原文檢查每一處修改；Grok 寫 REDLINE-MEMO.md：每處修改、依據的準則，以及要怎麼跟廠商說。合約是機密：每位成員都用我們自己的 vLLM 伺服器上的 ${ENDPOINT.member()}。`,
    },
  },
  async drive(s) {
    const { page, moveClick, mark } = s;
    const T = M(s);
    // Settings → Model backends: the server of your own, then the lead agent on it.
    await s.moveTo(700, 420, 300);
    await page.locator('#settings-backends').scrollIntoViewIfNeeded();
    await sleep(3500);
    const lead = page.locator('#settings-lead');
    if (await lead.count()) {
      await lead.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      mark('lead-model');
      await sleep(3000);
    }
    await moveClick(page.getByRole('button', { name: T.sidebar.newChat, exact: true }), { after: 900 });
    await page.waitForSelector('.new-chat-page .preset-card');
    const id = await startChat(s, { permission: 'edit', leadReview: false });
    const plan = await askTeam(s, id, this.text[s.lang]!.question!, { replies: allOf });
    const off = (plan?.agents ?? []).filter((a) => a.model && a.model !== ENDPOINT.member());
    if (off.length) s.log('WARNING: members not on the endpoint:', off.map((a) => `${a.name} ${a.model}`).join(', '));
    await readBack(s, 1800);
    mark('q1-read');
    // The first reply that changed the contract: its diff is the redline.
    await showDiff(s, id, /contract\.md$/i, 'redline');
    const memo = changedFile(await s.conversation(id), /REDLINE-MEMO\.md$/i);
    if (memo) {
      mark('files', { file: memo });
      await openFile(s, memo.split('/'), 3000);
      await readMarkdown(s, 70);
      await sleep(2000);
    }
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Settings → Model backends: your own vLLM server, serving Qwen3.8 27B.' },
      { at: 'lead-model', kind: 'you', say: 'The lead agent runs on it too, as every member’s default model does.' },
      {
        at: 'chat-open',
        kind: 'you',
        say: 'In vendor-contract, with Edit: ask for a redline of the vendor’s draft against your playbook.',
      },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, in relay, each on your server, and says why.' },
      {
        at: 'q1-confirmed',
        kind: 'team',
        team: 'q1',
        say: 'One edits the clauses, one checks each edit, one writes the memo for the vendor.',
      },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command its permission does not cover: you allow it.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'Each reply lists the files it changed: the contract, then the memo.' },
      { at: 'redline', kind: 'you', say: 'Open @{redline:agent}’s diff of contract.md: the redline, clause by clause.' },
      { at: 'files', kind: 'you', say: 'Open REDLINE-MEMO.md in Files: each change, its rule, and what to tell the vendor.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '設定 → 模型來源：你自己的 vLLM 伺服器，跑的是 Qwen3.8 27B。' },
      { at: 'lead-model', kind: 'you', say: '首席 agent 也用它，每位成員的預設模型也是它。' },
      { at: 'chat-open', kind: 'you', say: '在 vendor-contract 開新對話、權限選「可編輯」：請他們依你的審閱準則修訂廠商的草稿。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，以接力進行、都用你的伺服器，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '一位改條款、一位檢查每處修改、一位寫給廠商的說明。' },
      { at: 'approval', kind: 'agent', say: '要執行權限之外的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '每則回覆都列出它改了哪些檔案：先是合約，再是說明。' },
      { at: 'redline', kind: 'you', say: '打開 @{redline:agent} 改 contract.md 的差異：逐條的修訂紀錄。' },
      { at: 'files', kind: 'you', say: '在「檔案」打開 REDLINE-MEMO.md：每處修改、依據的準則，以及要跟廠商說什麼。' },
    ],
  },
};

// --- 10. On-call engineer: an alert starts the team -----------------------------------------------

const triageAlert: UseCase = {
  slug: 'triage-an-alert',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 80,
  poster: { at: 'inbox', offset: 1.5, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'checkout-service'));
    checkoutService(cwd, lang);
    return { cwd };
  },
  start: NEW_CHAT,
  text: {
    en: {
      message:
        'Our monitoring calls this automation’s webhook when an alert fires. Read the alert, then logs/, DEPLOYS.md and RUNBOOK.md, and tell the on-call engineer the likely cause, how sure you are, and the first thing to do. Claude Code reads the logs, Codex checks the deploys, Grok argues against their conclusion before they settle on one.',
    },
    'zh-TW': {
      message:
        '告警觸發時，我們的監控系統會呼叫這個自動任務的 webhook。請讀告警內容，再讀 logs/、DEPLOYS.md 和 RUNBOOK.md，告訴值班工程師最可能的原因、有多確定，以及第一步該做什麼。Claude Code 讀 log，Codex 查部署紀錄，Grok 在他們定案前先唱反調。',
    },
  },
  async drive(s) {
    const { page, moveClick, mark } = s;
    const id = await newAutomation(s, { message: this.text[s.lang]!.message!, webhook: true, newChat: true });
    // The drawer shows the webhook's address and token, this once, with a command to call it.
    const example = page.locator('.schedule-drawer .hook-example');
    await example.waitFor({ timeout: 30_000 });
    await example.scrollIntoViewIfNeeded().catch(() => {});
    mark('token');
    await sleep(3500);
    const command = (await example.textContent()) ?? '';
    const url = /https?:\/\/127\.0\.0\.1:\d+\/api\/hooks\/[^\s'"]+/.exec(command)?.[0];
    const token = /Bearer ([\w-]+)/.exec(command)?.[1];
    if (!url || !token) throw new Error(`No webhook address or token in: ${command}`);
    await page.keyboard.press('Escape');
    await sleep(600);
    const plan = await s.designAndConfirm(id, 'q1');
    await sleep(1500);

    // The alert fires: the monitoring system calls the webhook, and a new chat starts with the team.
    mark('alert');
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(checkoutAlert()),
    });
    const sent = (await r.json()) as { chatId?: string };
    if (!r.ok || !sent.chatId) throw new Error(`The webhook answered ${r.status}: ${JSON.stringify(sent)}`);
    s.log('webhook chat', sent.chatId);
    await sleep(2500);
    // The team works in the new chat while you are elsewhere; the bell says when it is done.
    await s.waitAnswered(sent.chatId, 'q1', firstRound(plan));
    await sleep(1500);
    const bell = page.locator('.inbox-button');
    await bell.waitFor({ timeout: 30_000 }).catch(() => {});
    mark('inbox');
    await moveClick(bell, { after: 1500 });
    await sleep(1800);
    const title = (await s.summary(sent.chatId))?.title ?? '';
    const item = page.locator('.inbox-item', { hasText: title }).first();
    await moveClick((await item.count()) ? item : page.locator('.inbox-item').first(), { after: 1200 });
    await page.waitForURL((u) => idFromUrl(u.href) === sent.chatId, { timeout: 15_000 }).catch(() => {});
    await sleep(1500);
    mark('opened');
    await readBack(s, 1600);
    mark('q1-read');
    return sent.chatId;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'New automation with no set times: what to tell the team when an alert fires, read-only.' },
      { at: 'webhook-on', kind: 'you', say: 'Let another program start it: a webhook, and a new chat for each alert.' },
      { at: 'token', kind: 'you', say: 'Its address and token, shown this once, with a command to call it.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: 'Designs the team for the message: {names}, and says why.' },
      { at: 'alert', kind: 'you', say: 'The checkout error rate passes 1 %: the monitoring calls the webhook with the alert.' },
      { at: 'q1-answering', kind: 'team', team: 'q1', say: 'A new chat starts by itself: they read the alert, the logs and the deploys.' },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command read-only does not cover by itself: you allow it.' },
      { at: 'inbox', kind: 'you', say: 'The bell says the team is done; its notification opens the chat.' },
      { at: 'opened', kind: 'team', team: 'q1', say: 'The likely cause, how sure they are, and the first step from the runbook.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '新自動任務，不設時間：告警觸發時要交給團隊的事，權限唯讀。' },
      { at: 'webhook-on', kind: 'you', say: '讓別的程式啟動它：建立 webhook，每次告警都開新對話。' },
      { at: 'token', kind: 'you', say: '它的網址和 token 只顯示這一次，附上呼叫它的指令。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '為這則訊息設計團隊：{names}，並說明原因。' },
      { at: 'alert', kind: 'you', say: '結帳錯誤率超過 1%：監控系統帶著告警呼叫 webhook。' },
      { at: 'q1-answering', kind: 'team', team: 'q1', say: '新對話自動開始：他們讀告警、log 和部署紀錄。' },
      { at: 'approval', kind: 'agent', say: '要執行唯讀權限本身不涵蓋的指令前先問你：你選擇允許。' },
      { at: 'inbox', kind: 'you', say: '鈴鐺通知團隊完成了；點通知就打開那段對話。' },
      { at: 'opened', kind: 'team', team: 'q1', say: '最可能的原因、有多確定，以及處理手冊裡的第一步。' },
    ],
  },
};

// --- 11. Designer: review the screens before the usability test ----------------------------------

const designReview: UseCase = {
  slug: 'design-review',
  providers: ['claude', 'codex', 'grok'],
  approvals: 'allow',
  length: 75,
  poster: { at: 'asked', offset: 2, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'fernway'));
    writeAll(cwd, {
      'README.md':
        lang === 'en'
          ? '# Fernway\n\nThe sign-up flow, before Thursday’s usability test.\n'
          : '# Fernway\n\n註冊流程，星期四易用性測試之前。\n',
    });
    // The three screens, drawn by a headless browser at a phone's size.
    const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROME || undefined });
    const shots: Record<string, Buffer> = {};
    try {
      const page = await browser.newPage({ viewport: SCREEN, deviceScaleFactor: 2 });
      for (const [name, html] of Object.entries(signupScreens(lang))) {
        await page.setContent(html);
        shots[name] = await page.screenshot({ type: 'png' });
      }
    } finally {
      await browser.close();
    }
    return { cwd, attach: uploads(cwd, shots) };
  },
  start: NEW_CHAT,
  text: {
    en: {
      question:
        'Here are the three sign-up screens of our app, before Thursday’s usability test. Have Claude Code look at accessibility, Codex at layout and visual hierarchy, and Grok at the words on screen, each on its own; then give me the five issues to fix first, each with its screen and a fix.',
    },
    'zh-TW': {
      question:
        '這是我們 app 的三張註冊畫面，星期四要做易用性測試。請 Claude Code 看無障礙、Codex 看版面與視覺層次、Grok 看畫面上的文字，各自獨立看；最後給我最該先改的五個問題，每個都標出是哪張畫面，並附上改法。',
    },
  },
  async drive(s, p) {
    const { page, mark } = s;
    const id = await startChat(s, { permission: 'read-only', leadReview: false });
    await attach(s, p.attach ?? []);
    await s.ask(this.text[s.lang]!.question!);
    mark('asked');
    // The screens, as they went with the question: on screen while the lead agent designs the team.
    await page
      .locator('.msg-attachments img')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    await sleep(3000);
    const plan = await s.designAndConfirm(id, 'q1', { poster: false });
    await s.waitAnswered(id, 'q1', firstRound(plan));
    await sleep(800);
    await readBack(s, 2200);
    mark('q1-read');
    await sleep(1500);
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'Start a new conversation, read-only: the agents only look and answer.' },
      { at: 'attached', kind: 'you', say: 'Attach the three sign-up screens, and ask for a review from three angles.' },
      { at: 'asked', offset: 1, kind: 'you', say: 'The screenshots go with the question, as images each agent sees.' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{Plan}: {names}, each on its own, and says why.' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: 'Each looks at the screens for its own angle, without seeing the others.' },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command read-only does not cover by itself: you allow it.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'Three reviews side by side, each issue with its screen and a fix.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '開新對話，權限維持唯讀：agent 只看、只回答。' },
      { at: 'attached', kind: 'you', say: '附上三張註冊畫面，請他們從三個角度審查。' },
      { at: 'asked', offset: 1, kind: 'you', say: '截圖隨問題一起送出，每位 agent 都看得到圖。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '{plan}：{names}，各自處理，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '每位從自己的角度看畫面，看不到其他人的答案。' },
      { at: 'approval', kind: 'agent', say: '要執行唯讀權限本身不涵蓋的指令前先問你：你選擇允許。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '三份審查並排，每個問題都標出畫面並附上改法。' },
    ],
  },
};

// --- 12. Localization: translate the strings the moment the English changes ---------------------

const translateStrings: UseCase = {
  slug: 'translate-strings',
  providers: ['antigravity', 'copilot', 'claude'],
  approvals: 'allow',
  length: 85,
  poster: { at: 'diff', offset: 2.4, fallback: 'q1-answered' },
  async prepare(lang, root) {
    const cwd = fresh(join(root, 'fernway-app'));
    fernwayStrings(cwd, lang);
    return { cwd, later: () => addReminderStrings(cwd) };
  },
  start: NEW_CHAT,
  text: {
    en: {
      message:
        'When locales/en.json changes: translate each string that was added or changed into locales/zh-TW.json and locales/ja.json, following GLOSSARY.md, and keep every {placeholder}, plural and tag as it is. As a relay: Antigravity translates; Copilot reads only the two translations, never en.json, and translates them back into English; Claude Code compares the back-translations with en.json, checks the placeholders and the button lengths, and sends any string whose meaning drifted back to Antigravity to fix.',
      note: 'One more thing: Snooze is 稍後提醒 in zh-TW and あとで in Japanese, as in our iOS app.',
    },
    'zh-TW': {
      message:
        'locales/en.json 一有變動：把新增或改過的字串翻成 locales/zh-TW.json 和 locales/ja.json，遵守 GLOSSARY.md，每個 {placeholder}、複數規則和標籤都原樣保留。用接力的方式：Antigravity 翻譯；Copilot 只讀兩份譯文、不打開 en.json，把它們回譯成英文；Claude Code 比對回譯和 en.json，檢查 placeholder 和按鈕長度，意思跑掉的字串退回給 Antigravity 修正。',
      note: '補充一下：Snooze 在繁中用「稍後提醒」，日文用「あとで」，跟我們的 iOS 版一致。',
    },
  },
  async drive(s, p) {
    const { page, mark } = s;
    const text = this.text[s.lang]!;
    const id = await newAutomation(s, {
      message: text.message!,
      file: 'locales/en.json',
      askUnwatched: true,
      permission: 'edit',
      title: s.lang === 'en' ? 'Fernway strings' : 'Fernway 字串',
    });
    const plan = await s.designAndConfirm(id, 'q1');
    await sleep(1500);
    // The first check only notes the files as they are.
    await checkNow(s, 'first-check');
    // You add the new screen's strings to en.json, in your editor.
    p.later?.();
    mark('edited', { strings: NEW_STRINGS });
    await openFile(s, ['locales', 'en.json'], 1500);
    await page.evaluate(scrollCodeTo, 'reminders.title');
    await sleep(3500);
    // The Files panel is a dialog: closed as the diff is.
    await page.keyboard.press('Escape');
    await page
      .locator('.file-browser')
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(() => {});
    await sleep(800);
    // A file counts once it has not changed for 30 seconds (one still being written starts it once).
    s.setFast(true);
    await sleep(33_000);
    s.setFast(false);
    await checkNow(s, 'check-now');
    // The check starts the team in this chat. While the first agent works, you add a note.
    if (await waitRunning(s, id)) {
      s.setFast(true);
      await sleep(6000);
      s.setFast(false);
      await s.ask(text.note!);
      mark('queued');
      await sleep(3000);
    }
    await s.waitAnswered(id, 'q1', allOf(plan));
    await sleep(800);
    await readBack(s, 1800);
    mark('q1-read');
    await showDiff(s, id, /locales\/ja\.json$/i, 'diff');
    return id;
  },
  rail: {
    en: [
      { at: 'start', kind: 'you', say: 'New automation: what to do each time the English strings change.' },
      { at: 'when', kind: 'you', say: 'It waits for a file: locales/en.json, in the working directory.' },
      {
        at: 'permission',
        kind: 'you',
        say: 'With Edit, so the agents may write the translations; what goes beyond it is asked, not refused.',
      },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: 'Designs the team for the message: {names}, in relay, and says why.' },
      { at: 'first-check', kind: 'you', say: 'Check now: the first check only notes the files as they are.' },
      { at: 'edited', kind: 'you', say: `You add the new screen’s ${NEW_STRINGS} strings to en.json, with a plural and tags.` },
      { at: 'check-now', kind: 'you', say: 'Once the file has been still for 30 seconds, check again: the change starts the team.' },
      { at: 'queued', kind: 'you', say: 'While they work, add a note: it waits above the box and reaches the next agent before its turn.' },
      { at: 'approval', kind: 'agent', say: 'Asks before running a command its permission does not cover: you allow it.' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: 'Translated, translated back without the English, then checked: your note fixes the Japanese Snooze.',
      },
      { at: 'diff', kind: 'you', say: 'Open @{diff:agent}’s diff: only the new strings, each placeholder kept.' },
    ],
    'zh-TW': [
      { at: 'start', kind: 'you', say: '新自動任務：每次英文字串一變，要團隊做的事。' },
      { at: 'when', kind: 'you', say: '它等一個檔案：工作目錄裡的 locales/en.json。' },
      { at: 'permission', kind: 'you', say: '權限選「可編輯」，agent 才能寫譯文；超出權限的動作會問你，不自動拒絕。' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '為這則訊息設計團隊：{names}，以接力進行，並說明原因。' },
      { at: 'first-check', kind: 'you', say: '按「立即檢查」：第一次檢查只記下檔案現在的樣子。' },
      { at: 'edited', kind: 'you', say: `你在 en.json 加上新畫面的 ${NEW_STRINGS} 個字串，含複數規則和標籤。` },
      { at: 'check-now', kind: 'you', say: '檔案靜止 30 秒後再檢查一次：這次變動啟動了團隊。' },
      { at: 'queued', kind: 'you', say: '他們還在做，你補一句：訊息先在輸入框上方等著，下一位開始前就會收到。' },
      { at: 'approval', kind: 'agent', say: '要執行權限之外的指令前先問你：你選擇允許。' },
      {
        at: 'q1-answered',
        kind: 'team',
        team: 'q1',
        say: '翻譯、不看英文回譯，再檢查：日文兩個字串退回重翻，其中一個就是你補充的 Snooze。',
      },
      { at: 'diff', kind: 'you', say: '打開 @{diff:agent} 的差異：只動了新字串，每個 placeholder 都保留。' },
    ],
  },
};

export const USE_CASES: readonly UseCase[] = [
  fixABug,
  productSpec,
  launchCopy,
  reconcile,
  collectPayments,
  callBrief,
  literatureReview,
  writeAQuiz,
  contractReview,
  triageAlert,
  designReview,
  translateStrings,
];

export function useCase(slug: string): UseCase {
  const found = USE_CASES.find((u) => u.slug === slug);
  if (!found) throw new Error(`No use case ${slug}: one of ${USE_CASES.map((u) => u.slug).join(', ')}`);
  return found;
}
