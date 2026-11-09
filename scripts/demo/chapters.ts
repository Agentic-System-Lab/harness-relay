/**
 * The landing page's chapter rail, written from a recording's timeline: each chapter starts at one
 * of the recorder's marks, so re-recording re-times it. Teams, the lead agent, the agent asking for
 * an approval, the group and the search term come from the marks too; the sentences are below.
 * When the agents do something new in a recording, change the sentences here (review.md, written
 * next to the recording, lists what they did).
 */
import { PROVIDER_LABEL, type Provider } from '../../src/shared/types';
import type { DemoLang, Timeline, TimelineMark } from './common';

export interface ChapterSpec {
  /** The mark the chapter starts at. A chapter whose mark is not in the recording (an approval that never came) is left out. */
  at: string;
  /** Seconds added to the mark's time. */
  offset?: number;
  kind: 'you' | 'lead' | 'agent' | 'team';
  /** Lead and team chapters: which question's team (its `<team>-confirmed` mark names the members). */
  team?: 'q1' | 'q2';
  /** Instead of the name worked out from the team. */
  who?: string;
  /**
   * The sentence. Placeholders: {group}, {template}, {term} (the search), and for the chapter's team
   * {plan} (how the lead agent chose it), {names} and {rounds}.
   */
  say: string;
}

export interface RailSpec {
  /** The page whose rail it is, from the repository root. */
  page: string;
  you: string;
  lead: string;
  chapters: ChapterSpec[];
}

export const RAILS: Record<DemoLang, RailSpec> = {
  en: {
    page: 'site/index.html',
    you: 'You',
    lead: 'Lead agent',
    chapters: [
      { at: 'start', kind: 'you', say: 'Create a group, “{group}”, and open a template: teams are designed in templates.' },
      { at: 'chat-open', kind: 'you', say: 'Start a new chat and ask straight away: “Is relay mode a good design?”' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: 'Sorts the chat into {group}, {plan}, and says why.' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: 'Once you confirm, {rounds}: they read the code, each building on and challenging the last.' },
      { at: 'approval', kind: 'agent', say: 'Wants to run a script to probe the @mention parser, beyond read-only: it waits in the chat, and you decline.' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: 'The answers, down to a ranked list of what to change first.' },
      { at: 'q1-read', kind: 'you', say: 'Ask a new question: a short README note on relay mode.' },
      { at: 'q2-plan', kind: 'lead', team: 'q2', say: 'Picks a team for it: {names}, {rounds}. The review team stays until you confirm.' },
      { at: 'q2-confirmed', kind: 'team', team: 'q2', say: 'Draft the note and check it against the code.' },
      { at: 'files', kind: 'you', say: 'Open Files and read relay mode’s hand-off in orchestrator.ts, right in the chat’s working directory.' },
      { at: 'search', kind: 'you', say: 'Search for “{term}” and find the chat by what the agents wrote.' },
    ],
  },
  'zh-TW': {
    page: 'site/zh-TW/index.html',
    you: '你',
    lead: '首席 agent',
    chapters: [
      { at: 'start', kind: 'you', say: '新增群組「{group}」，再打開一個範本：團隊就是在範本裡設計的。' },
      { at: 'chat-open', kind: 'you', say: '開新對話，直接提問：「接力模式的設計好嗎？」' },
      { at: 'q1-plan', kind: 'lead', team: 'q1', say: '依你的第一則訊息把對話歸進「{group}」，{plan}，並說明原因。' },
      { at: 'q1-confirmed', kind: 'team', team: 'q1', say: '確認後{rounds}圓桌：依序讀程式碼，每位都接續並挑戰前面的說法。' },
      { at: 'approval', kind: 'agent', say: '想實際執行一段指令來驗證 @ 點名的解析，超出唯讀，在聊天裡等你決定，你選擇拒絕。' },
      { at: 'q1-answered', kind: 'team', team: 'q1', say: '結論：排好優先順序的修改建議，從最先該改的開始。' },
      { at: 'q1-read', kind: 'you', say: '問新的問題：寫一段放在 README 的接力模式說明。' },
      { at: 'q2-plan', kind: 'lead', team: 'q2', say: '為它挑新團隊：{names}，{rounds}。確認之前，對話仍是原本的審查團隊。' },
      { at: 'q2-confirmed', kind: 'team', team: 'q2', say: '撰寫說明，並對照程式碼查核用詞。' },
      { at: 'files', kind: 'you', say: '打開「檔案」，直接在對話的工作目錄裡看 orchestrator.ts 中接力模式交棒的程式碼。' },
      { at: 'search', kind: 'you', say: '搜尋「{term}」，依對話內容找回這段對話。' },
    ],
  },
};

/** A chapter ready to write: the rail's markup takes these fields. */
export interface Chapter {
  t: number;
  kind: ChapterSpec['kind'];
  who: string;
  say: string;
  /** Lead and agent: the avatar's initial, the provider's colour and its name. */
  av?: string;
  tone?: Provider;
  via?: string;
  /** Team: each member's initial and provider. */
  members?: [string, Provider][];
}

const NUMBERS: Record<DemoLang, string[]> = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six'],
  'zh-TW': ['零', '一', '兩', '三', '四', '五', '六'],
};
const number = (lang: DemoLang, n: number) => NUMBERS[lang][n] ?? String(n);

/** "A and B", "A, B and C"; "A 與 B", "A、B 與 C". */
export function joinNames(lang: DemoLang, names: string[]): string {
  if (names.length <= 1) return names.join('');
  const [last, rest] = [names[names.length - 1], names.slice(0, -1)];
  return lang === 'en' ? `${rest.join(', ')} and ${last}` : `${rest.join('、')} 與 ${last}`;
}

/** A team's name in the rail: its members' names, or "All three" for three or more. */
export function teamWho(lang: DemoLang, names: string[]): string {
  if (names.length < 3) return joinNames(lang, names);
  return lang === 'en' ? `All ${number(lang, names.length)}` : `${number(lang, names.length)}位成員`;
}

export function rounds(lang: DemoLang, n: number): string {
  return lang === 'en' ? `${number(lang, n)} round${n === 1 ? '' : 's'}` : `${number(lang, n)}輪`;
}

/** How the lead agent chose a team, from its `<team>-confirmed` mark. */
export function planPhrase(lang: DemoLang, m: TimelineMark): string {
  const name = String(m.team ?? '');
  const basedOn = String(m.basedOn ?? name);
  const en: Record<string, string> = {
    adapted: `adapts the ${basedOn} template for the question`,
    template: `picks the ${name} template`,
    custom: `designs a new team for the question`,
    kept: 'keeps the current team',
    fallback: `falls back to ${name}`,
  };
  const zh: Record<string, string> = {
    adapted: `以「${basedOn}」範本為這個問題調整出團隊`,
    template: `選用「${name}」範本`,
    custom: '為這個問題設計新團隊',
    kept: '沿用目前的團隊',
    fallback: `改用「${name}」`,
  };
  return (lang === 'en' ? en : zh)[String(m.source)] ?? (lang === 'en' ? en.custom : zh.custom);
}

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';

/** Resolves a rail's chapters against a recording's timeline. Pure. */
export function buildChapters(lang: DemoLang, spec: RailSpec, timeline: Timeline): { chapters: Chapter[]; missing: string[] } {
  const find = (name: string) => timeline.marks.find((m) => m.name === name);
  const fact = (mark: string, key: string) => String(find(mark)?.[key] ?? '');
  const chapters: Chapter[] = [];
  const missing: string[] = [];
  for (const c of spec.chapters) {
    const at = find(c.at);
    if (!at) {
      missing.push(c.at);
      continue;
    }
    const team = c.team ? find(`${c.team}-confirmed`) : undefined;
    if (c.team && !team) {
      missing.push(`${c.team}-confirmed`);
      continue;
    }
    const agents = (team?.agents as [string, Provider][] | undefined) ?? [];
    const names = agents.map(([name]) => name);
    const say = c.say.replace(/\{(\w+)\}/g, (whole, key: string) => {
      switch (key) {
        case 'group':
          return fact('group-made', 'group');
        case 'template':
          return fact('template-shown', 'template');
        case 'term':
          return fact('search', 'term');
        case 'plan':
          return team ? planPhrase(lang, team) : whole;
        case 'names':
          return joinNames(lang, names);
        case 'rounds':
          return rounds(lang, Number(team?.rounds ?? 1));
        default:
          throw new Error(`Unknown placeholder ${whole} in a ${lang} chapter`);
      }
    });
    const t = Math.max(0, Math.round(at.video + (c.offset ?? 0)));
    if (c.kind === 'you') chapters.push({ t, kind: 'you', who: c.who ?? spec.you, say });
    else if (c.kind === 'lead') {
      const lead = (team?.lead as Provider | undefined) ?? 'claude';
      chapters.push({ t, kind: 'lead', who: c.who ?? spec.lead, say, av: initial(PROVIDER_LABEL[lead]), tone: lead, via: PROVIDER_LABEL[lead] });
    } else if (c.kind === 'agent') {
      const name = String(at.agent ?? '');
      const provider = (at.provider as Provider | undefined) ?? 'claude';
      chapters.push({ t, kind: 'agent', who: c.who ?? `@${name}`, say, av: initial(name), tone: provider, via: PROVIDER_LABEL[provider] });
    } else {
      chapters.push({ t, kind: 'team', who: c.who ?? teamWho(lang, names), say, members: agents.map(([name, p]) => [initial(name), p]) });
    }
  }
  return { chapters, missing };
}

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const clock = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

/** The rail's `<ol class="chapters">`, indented as in the pages. */
export function renderRail(chapters: Chapter[]): string {
  const I = ' '.repeat(14);
  const actor = (c: Chapter) => {
    if (c.kind === 'you') return `<span class="actor"><span class="av av-you" aria-hidden="true"></span><span class="who">${esc(c.who)}</span></span>`;
    if (c.kind === 'team') {
      const stack = (c.members ?? []).map(([av, tone]) => `<span class="av t-${tone}">${esc(av)}</span>`).join('');
      return (
        `<span class="actor"\n${I}      ><span class="stack" aria-hidden="true"\n${I}        >${stack}</span\n${I}      >` +
        `<span class="who">${esc(c.who)}</span></span\n${I}    >`
      );
    }
    const via = c.via ? `<span class="via">${esc(c.via)}</span>` : '';
    return (
      `<span class="actor"\n${I}      ><span class="av" aria-hidden="true">${esc(c.av ?? '')}</span><span class="who">${esc(c.who)}</span` +
      `\n${I}      >${via}</span\n${I}    >`
    );
  };
  const items = chapters.map((c) => {
    const tone = c.kind === 'you' ? '' : c.kind === 'team' ? ' t-team' : ` t-${c.tone}`;
    return [
      `${I}<li>`,
      `${I}  <button class="chapter${tone}" type="button" data-t="${c.t}">`,
      `${I}    <time>${clock(c.t)}</time>`,
      `${I}    ${actor(c)}`,
      `${I}    <span class="say">${esc(c.say)}</span>`,
      `${I}    <span class="bar" aria-hidden="true"></span>`,
      `${I}  </button>`,
      `${I}</li>`,
    ].join('\n');
  });
  return `<ol class="chapters">\n${items.join('\n')}\n${' '.repeat(12)}</ol>`;
}

/** The page with its chapter rail replaced. */
export function replaceRail(html: string, chapters: Chapter[]): string {
  const start = html.indexOf('<ol class="chapters">');
  if (start < 0) throw new Error('The page has no <ol class="chapters">');
  const end = html.indexOf('</ol>', start) + '</ol>'.length;
  return html.slice(0, start) + renderRail(chapters) + html.slice(end);
}
