/**
 * Records one language of the demo with the real CLIs.
 *
 * It starts Harness Relay on its own port with an empty data folder (the chat's working directory is
 * this repository), then drives it in a headless browser the way a person would (`recorder.ts`): a
 * new group, a template, a new chat and a question, the lead agent's team, the answers, a follow-up
 * question with a team of its own, the chat's files and a search.
 *
 * Written to `<out>/`: `frames/*.jpg`, `frames.jsonl` (each frame's time), `marks.json`,
 * `conversation.json` (the whole chat, to check the chapter texts against) and `server.log`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from '../../src/shared/types';
import { type DemoLang } from './common';
import { api, checkProviders as checkCliProviders, firstRound, recordSession, scrollCodeTo, sleep, type Log } from './recorder';

export { startServer, type DemoServer } from './recorder';

/** What is typed and clicked, per language. */
interface Scenario {
  newGroup: RegExp;
  groupName: string;
  /** The built-in template opened to show where teams are designed. */
  template: string;
  /** Names all three CLIs, so the lead agent's first team has one of each (the posters show it). */
  question: string;
  followup: string;
  files: RegExp;
  search: RegExp;
  skip: RegExp;
  /** Searched for when the agents wrote none of the identifiers in SEARCH_WORDS. */
  searchFallback: string;
}

export const SCENARIOS: Record<DemoLang, Scenario> = {
  en: {
    newGroup: /New group/,
    groupName: 'Design reviews',
    template: 'Three-way debate',
    question:
      'Is relay mode a good design? Have Claude Code, Codex and Grok review how agents hand off to each other in this repository, and tell me what to change first.',
    followup: 'Thanks. Now write a short note for the README that explains relay mode to new users.',
    files: /^Files$/,
    search: /^Search$/,
    skip: /Skip/,
    searchFallback: 'hand-off',
  },
  'zh-TW': {
    newGroup: /新群組/,
    groupName: '設計評審',
    template: '三方辯論',
    question: '接力模式的設計好嗎？請 Claude Code、Codex 和 Grok 一起看這個 repository 裡 agent 之間怎麼交棒，告訴我最先該改哪裡。',
    followup: '謝謝。接著幫我寫一段放在 README 的簡短說明，向新使用者介紹接力模式。',
    files: /^檔案$/,
    search: /^搜尋$/,
    skip: /略過/,
    searchFallback: '交棒',
  },
};

/** Words only the agents would write (identifiers from the code they read): the first one they used is searched for. */
const SEARCH_WORDS = ['maxHops', 'parseMentions', 'hopsLeft', 'takePause'];

export interface RecordOptions {
  lang: DemoLang;
  outDir: string;
  port: number;
  /** Stop once the chat is open, before anything is asked: checks the UI flow without running agents. */
  dry?: boolean;
  /** Minutes to wait for each step the agents take before going on anyway. */
  waitLimitMin?: number;
}

/** The CLIs the demo's first question asks for, one member each. */
export const DEMO_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'grok'];

/** Those CLIs installed and signed in, and Grok trusting this repository (it asks otherwise, and the demo would stop there). */
export function checkProviders(base: string, log: Log): Promise<void> {
  return checkCliProviders(base, log, DEMO_PROVIDERS);
}

/** Records one language. Returns the number of frames saved. */
export async function record(opts: RecordOptions, base: string, log: Log): Promise<number> {
  const { lang, outDir } = opts;
  const L = SCENARIOS[lang];
  let conversationId = '';
  // The app opens on its home page, and the demo starts on a new chat.
  const frames = await recordSession(
    { lang, outDir, waitLimitMin: opts.waitLimitMin, approvals: 'decline', skip: L.skip },
    base,
    log,
    '#/new',
    '.new-chat-page .first-question',
    async (s) => {
      const { page, mark, moveTo, moveClick, typeSlow, ask, scrollMessages, conversation, agentReplies } = s;
      await moveTo(700, 420, 300);
      await sleep(1500);

      // A group to sort chats into.
      await moveClick(page.getByRole('button', { name: L.newGroup }), { after: 400 });
      await typeSlow(L.groupName, 60);
      await sleep(400);
      await page.keyboard.press('Enter');
      await sleep(1200);
      mark('group-made', { group: L.groupName });

      // Templates are where teams are designed: open one.
      await moveClick('.template-library > summary');
      await moveClick(page.locator('.preset-card', { hasText: L.template }).locator('.preset-main'), { after: 600 });
      await page.waitForSelector('.modal.template-editor');
      await sleep(1800);
      await page.evaluate(async () => {
        const body = document.querySelector('.template-editor-body');
        for (let i = 0; i < 40 && body; i++) {
          body.scrollTop += 6;
          await new Promise((r) => setTimeout(r, 16));
        }
      });
      await sleep(1500);
      mark('template-shown', { template: L.template });
      await moveClick(page.locator('.template-editor-foot .ghost'), { after: 700 });

      // Start the chat and ask straight away. Without lead review (the page ticks it in every new chat),
      // which the chapters and stills do not show.
      await moveClick('.chat-options > summary');
      await page.locator('.lead-review input[type="checkbox"]').uncheck();
      await moveClick('.start-bar .primary', { after: 900 });
      await page.waitForURL(/#\/c\//);
      const id = decodeURIComponent(/#\/c\/([^/?]+)/.exec(page.url())?.[1] ?? '');
      conversationId = id;
      log('conversation', id);
      await sleep(1200);
      mark('chat-open');
      if (opts.dry) {
        await page.screenshot({ path: join(outDir, 'dry.png') });
        return;
      }

      await ask(L.question);
      mark('asked', { question: L.question });
      const first = await s.designAndConfirm(id, 'q1', { poster: true }); // the first team, all three agents on the card
      await s.waitAnswered(id, 'q1', firstRound(first));
      await sleep(800);
      // Read the answers: up through the last replies, then back down.
      await scrollMessages(-900, 2600);
      await sleep(1800);
      await scrollMessages(500, 2200);
      await sleep(1500);
      await scrollMessages(2000, 1500);
      await sleep(1000);
      mark('q1-read');

      // A new question gets a team of its own. (Replies counted before it is asked: once its team is
      // confirmed, the first reply is already being written.)
      const before = agentReplies(await conversation(id));
      await ask(L.followup);
      mark('followup-asked', { question: L.followup });
      const second = await s.designAndConfirm(id, 'q2');
      await s.waitAnswered(id, 'q2', before + firstRound(second));
      await sleep(800);
      await scrollMessages(-500, 2000);
      await sleep(2200);
      await scrollMessages(2000, 1200);
      await sleep(1000);
      mark('q2-read');

      // The code they discussed, in the chat's working directory.
      mark('files');
      await moveClick(page.getByRole('button', { name: L.files }), { after: 900 });
      await page.waitForSelector('.file-browser');
      for (const name of ['src', 'server', 'orchestrator.ts']) {
        await moveClick(
          page.locator('.file-list .file-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
          { after: 700 },
        );
      }
      await sleep(1200);
      // Relay mode's hand-off (`if (mode === 'relay')`), a third of the way down the preview.
      await page.evaluate(scrollCodeTo, "if (mode === 'relay')");
      await sleep(3500);
      mark('files-shown');
      await page.keyboard.press('Escape');
      await sleep(800);

      // Find the chat again by what the agents wrote.
      await moveClick(page.getByRole('button', { name: L.search }), { after: 500 });
      const said = (await conversation(id)).messages
        .filter((m) => m.author.kind === 'agent')
        .flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])))
        .join('\n');
      const term = SEARCH_WORDS.find((w) => said.includes(w)) ?? L.searchFallback;
      mark('search', { term });
      await typeSlow(term, 90);
      await sleep(1800);
      await moveClick(page.locator('.search-hit .conv-link').first(), { after: 1500 });
      await sleep(2000);
    },
  );
  if (!opts.dry && conversationId) {
    const c = await api(base, `/api/conversations/${conversationId}`);
    writeFileSync(join(outDir, 'conversation.json'), JSON.stringify(c, null, 1) + '\n');
  }
  return frames;
}
