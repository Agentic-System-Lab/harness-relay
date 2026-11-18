/**
 * The folders the use cases run in, made fresh for each recording: small projects with a git history,
 * documents to attach, spreadsheets, a mailbox for the stand-in mail server, websites for the stand-in
 * web server, and the screens a design review looks at. Everything in them is made up (people, companies,
 * products, numbers), and the same every time.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DemoLang } from '../common';

/** Writes `files` (path → text) under `dir`. */
export function writeAll(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** The English or the Chinese one. */
const by = <T>(lang: DemoLang, en: T, zh: T): T => (lang === 'en' ? en : zh);

/** A commit's author and time, as `git` takes them from the environment. */
interface Who {
  name: string;
  email: string;
  date: string;
}

function git(dir: string, args: string[], who?: Who): string {
  const env = {
    ...process.env,
    // No settings of the user's: a global config file that is not there (in the repository's .git, never written).
    GIT_CONFIG_GLOBAL: join(dir, '.git', 'no-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...(who
      ? {
          GIT_AUTHOR_NAME: who.name,
          GIT_AUTHOR_EMAIL: who.email,
          GIT_AUTHOR_DATE: who.date,
          GIT_COMMITTER_NAME: who.name,
          GIT_COMMITTER_EMAIL: who.email,
          GIT_COMMITTER_DATE: who.date,
        }
      : {}),
  };
  return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
}

function commit(dir: string, message: string, who: Who, files: Record<string, string>): void {
  writeAll(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], who);
}

function init(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
}

const ANA = (date: string): Who => ({ name: 'Ana Lima', email: 'ana@example.com', date });

/** A small seeded random number generator (mulberry32): the same numbers every time. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A day's date at a time, in this computer's time zone, `days` from today. */
export function at(days: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// --- Fix a bug: bill-split, whose tests fail -----------------------------------------------------

/** bill-split: splits a restaurant bill to the cent; `splitBill` rounds each share, so the shares miss the total. */
export function billSplit(dir: string): void {
  init(dir);
  commit(dir, 'Split a bill evenly among friends', ANA('2026-10-02T10:12:00+08:00'), {
    'package.json': JSON.stringify(
      {
        name: 'bill-split',
        version: '1.0.0',
        description: 'Split a restaurant bill evenly, to the cent.',
        type: 'module',
        scripts: { test: 'node --test' },
        license: 'MIT',
      },
      null,
      2,
    ),
    'README.md': [
      '# bill-split',
      '',
      'Split a restaurant bill evenly among friends, to the cent.',
      '',
      '```js',
      "import { splitBill } from './src/split.js';",
      'splitBill(1000, 3); // [334, 333, 333]',
      '```',
      '',
      'Amounts are whole cents. Run the tests with `npm test`.',
      '',
    ].join('\n'),
    'src/split.js': [
      '/**',
      ' * Splits a bill of `totalCents` among `people`, as evenly as cents allow.',
      ' * Every share is a whole number of cents, and the shares add up to the total.',
      ' */',
      'export function splitBill(totalCents, people) {',
      '  if (!Number.isInteger(totalCents) || totalCents < 0) {',
      "    throw new RangeError('totalCents must be a whole number of cents, 0 or more');",
      '  }',
      '  if (!Number.isInteger(people) || people < 1) {',
      "    throw new RangeError('people must be a whole number, 1 or more');",
      '  }',
      '  const share = Math.round(totalCents / people);',
      '  return Array.from({ length: people }, () => share);',
      '}',
      '',
    ].join('\n'),
    'src/receipt.js': [
      "import { splitBill } from './split.js';",
      '',
      '/** One line per friend: their name and what they pay, in dollars. */',
      'export function receipt(totalCents, names) {',
      '  const shares = splitBill(totalCents, names.length);',
      "  return names.map((name, i) => `${name.padEnd(8)} $${(shares[i] / 100).toFixed(2)}`).join('\\n');",
      '}',
      '',
    ].join('\n'),
    'test/split.test.js': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { receipt } from '../src/receipt.js';",
      "import { splitBill } from '../src/split.js';",
      '',
      "test('splits evenly when the total divides', () => {",
      '  assert.deepEqual(splitBill(900, 3), [300, 300, 300]);',
      '});',
      '',
      "test('the shares add up to the total', () => {",
      '  for (const [total, people] of [[1000, 3], [200, 3], [101, 4], [1, 2], [0, 5]]) {',
      '    const shares = splitBill(total, people);',
      '    assert.equal(shares.length, people);',
      '    assert.equal(shares.reduce((a, b) => a + b, 0), total, `${total} among ${people}`);',
      '  }',
      '});',
      '',
      "test('no two shares differ by more than a cent', () => {",
      '  const shares = splitBill(1001, 6);',
      '  assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);',
      '});',
      '',
      "test('the first friends pay the extra cents', () => {",
      '  assert.deepEqual(splitBill(1000, 3), [334, 333, 333]);',
      '  assert.deepEqual(splitBill(200, 3), [67, 67, 66]);',
      '});',
      '',
      "test('the receipt shows each share', () => {",
      "  assert.equal(receipt(1000, ['Ana', 'Ken', 'Mei']), 'Ana      $3.34\\nKen      $3.33\\nMei      $3.33');",
      '});',
      '',
      "test('refuses a bill for nobody', () => {",
      '  assert.throws(() => splitBill(100, 0), RangeError);',
      '});',
      '',
    ].join('\n'),
  });
}

// --- A product spec: Shiftbell's customers, and five interviews to attach -----------------------

/** What the product manager's folder holds: who Shiftbell's customers are. */
export function productNotes(lang: DemoLang): Record<string, string> {
  return {
    'PRODUCT.md': by(
      lang,
      [
        '# Shiftbell',
        '',
        'Shiftbell is a scheduling app for teams that work in shifts. A manager builds the week’s rota on the web;',
        'staff see their shifts, and get reminders, on their phones.',
        '',
        '- 182 paying customers: 141 restaurants and cafés (most of them one or two locations) and 41 clinics',
        '  (physiotherapy and dental groups, up to six sites).',
        '- Price: USD 4 per staff member a month.',
        '- Customers who leave each month: 4.1 % of restaurants and cafés, 0.9 % of clinics.',
        '- Next quarter the team can build one large feature.',
        '',
      ],
      [
        '# Shiftbell',
        '',
        'Shiftbell 是給輪班團隊用的排班 app。主管在網頁上排好一週的班表，員工在手機上看自己的班、收到提醒。',
        '',
        '- 182 家付費客戶：141 家餐廳與咖啡店（大多只有一到兩家店），41 家診所（物理治療與牙醫集團，最多六個據點）。',
        '- 價格：每位員工每月 NT$120。',
        '- 每月流失的客戶：餐廳與咖啡店 4.1%，診所 0.9%。',
        '- 下一季團隊能做一個大型功能。',
        '',
      ],
    ).join('\n'),
  };
}

/** The five customer interviews the product manager attaches: file name → text. */
export function interviews(lang: DemoLang): Record<string, string> {
  const en: Record<string, string[]> = {
    'interview-1-cafe-lume.md': [
      '# Interview: Marta Sousa, owner, Café Lume (two cafés)',
      '',
      '7 October 2026 · a customer for 14 months · 23 staff',
      '',
      '- Builds the rota on Sunday evenings. “Every Sunday night I rebuild the week from WhatsApp messages: who',
      '  swapped with whom, who can’t come on Tuesday.”',
      '- Staff swap shifts among themselves in a group chat, then tell her. She enters each swap by hand; twice',
      '  last month a swap never made it into Shiftbell and a shift went uncovered.',
      '- “If they could swap in the app and I just tapped yes, I’d get my Sundays back.”',
      '- Pays for Shiftbell herself, and compares it with a free spreadsheet every time the invoice comes.',
    ],
    'interview-2-nori-ramen.md': [
      '# Interview: Dev Patel, manager, Nori Ramen Bar',
      '',
      '9 October 2026 · a customer for 8 months · 16 staff',
      '',
      '- The worst moment is a sick call before a shift: “Someone texts at six in the morning, and I spend the',
      '  next hour calling people to find a cover.”',
      '- Keeps a paper list of who wants extra hours. Would pay more for a button that offers an open shift to',
      '  everyone free and qualified, first to say yes gets it.',
      '- Staff mostly open the app to check their shifts; few have notifications on.',
      '- Thought about leaving in the summer: “It doesn’t help me on a bad morning.”',
    ],
    'interview-3-crumb-bakery.md': [
      '# Interview: Joon Park, owner, Crumb & Co. bakery',
      '',
      '13 October 2026 · a customer for 2 years · 9 staff',
      '',
      '- Overtime surprises him on payday: “I only find out someone went over 40 hours when I run payroll.”',
      '- Wants a warning before he publishes the rota when anyone goes over their hours, or closes at night',
      '  and opens the next morning.',
      '- Watches every dollar: “Anything over 30 dollars a month and I’m back to paper.”',
      '- Swaps happen in person at the counter; he writes them on the printed rota.',
    ],
    'interview-4-motion-physio.md': [
      '# Interview: Dr Ana Ruiz, head of operations, Motion Physio (four clinics)',
      '',
      '15 October 2026 · a customer for 11 months · 64 staff',
      '',
      '- Each clinic’s lead should edit only their own clinic’s rota; today every manager can change every',
      '  clinic. “We need permissions by site before we open our fifth clinic.”',
      '- Therapists’ licences expire; she tracks them in a spreadsheet and wants a warning before anyone with',
      '  an expired licence is scheduled.',
      '- Wants one report of hours across all clinics for the monthly board meeting.',
      '- Buying anything new takes their IT team two to three months, and needs single sign-on.',
    ],
    'interview-5-brightsmile-dental.md': [
      '# Interview: Priya Nair, scheduler, Brightsmile Dental (three clinics)',
      '',
      '20 October 2026 · a customer for 6 months · 38 staff',
      '',
      '- Hygienists move between clinics. Twice this quarter one was booked at two clinics on the same',
      '  morning: “The app should never let me do that.”',
      '- Copies hours into a spreadsheet for payroll every two weeks; wants a payroll export.',
      '- Likes the idea of swap requests, but only with a rule that keeps a qualified person on every chair.',
    ],
  };
  const zh: Record<string, string[]> = {
    'interview-1-cafe-lume.md': [
      '# 訪談：蘇瑪莉，拾光咖啡老闆（兩家店）',
      '',
      '2026 年 10 月 7 日 · 使用 14 個月 · 23 位員工',
      '',
      '- 每週日晚上排班表。「每個星期天晚上，我都要從 LINE 訊息裡把整週重排一次：誰跟誰換了班、誰星期二不能來。」',
      '- 員工在群組裡自己換班，再告訴她。她一筆一筆手動輸入；上個月有兩次換班沒輸入 Shiftbell，結果那個班沒人上。',
      '- 「如果他們能在 app 裡換班，我只要按一下同意，我的星期天就回來了。」',
      '- Shiftbell 是她自己付錢，每次帳單來都會跟免費的試算表比一比。',
    ],
    'interview-2-nori-ramen.md': [
      '# 訪談：陳德偉，海苔拉麵店長',
      '',
      '2026 年 10 月 9 日 · 使用 8 個月 · 16 位員工',
      '',
      '- 最痛苦的是開班前有人請病假：「早上六點有人傳訊息說不能來，我接下來一個小時都在打電話找人代班。」',
      '- 用一張紙記誰想多排班。願意多付錢買一個按鈕：把空出來的班發給所有有空又能上的人，先答應的人拿到。',
      '- 員工大多只打開 app 看自己的班，很少人開通知。',
      '- 夏天時考慮過不用了：「我早上手忙腳亂的時候，它一點都幫不上忙。」',
    ],
    'interview-3-crumb-bakery.md': [
      '# 訪談：林俊宏，麥香烘焙坊老闆',
      '',
      '2026 年 10 月 13 日 · 使用 2 年 · 9 位員工',
      '',
      '- 加班費總是發薪時才嚇一跳：「我都是算薪水的時候才發現有人一週超過 40 小時。」',
      '- 希望發布班表前就提醒他：有人超過工時，或是晚上關店、隔天一早又開店。',
      '- 很在意價錢：「一個月超過一千塊，我就回去用紙本。」',
      '- 換班都是在櫃檯當面講好，他再寫在印出來的班表上。',
    ],
    'interview-4-motion-physio.md': [
      '# 訪談：阮安娜醫師，動能物理治療營運主管（四家診所）',
      '',
      '2026 年 10 月 15 日 · 使用 11 個月 · 64 位員工',
      '',
      '- 每家診所的主管應該只能改自己診所的班表；現在每位主管都能改所有診所。「開第五家診所之前，我們需要依據點分權限。」',
      '- 治療師的執照會到期；她用試算表追蹤，希望排到執照過期的人之前先跳出警告。',
      '- 每月董事會要一份所有診所的工時報表。',
      '- 買任何新系統，IT 部門都要兩到三個月，而且一定要單一登入（SSO）。',
    ],
    'interview-5-brightsmile-dental.md': [
      '# 訪談：倪佩雅，晴笑牙醫排班人員（三家診所）',
      '',
      '2026 年 10 月 20 日 · 使用 6 個月 · 38 位員工',
      '',
      '- 牙醫助理會在各診所之間支援。這一季有兩次，同一個早上被排到兩家診所：「app 應該根本不讓我這樣排。」',
      '- 每兩週把工時抄進試算表給會計算薪水；希望能直接匯出薪資資料。',
      '- 喜歡換班申請的點子，但前提是換完每張診療椅都還有合格的人。',
    ],
  };
  return Object.fromEntries(Object.entries(by(lang, en, zh)).map(([name, lines]) => [name, lines.join('\n') + '\n']));
}

// --- Launch copy: Plotline Studio's brief, and three competitors' pricing pages -----------------

/** The competitors whose pricing pages the stand-in web server serves, each under a name of its own on this computer. */
export const COMPETITORS = ['wavecut', 'podforge', 'echoroom'] as const;
export type Competitor = (typeof COMPETITORS)[number];

/** Where a competitor's pricing page is, on the stand-in web server's port. */
export const competitorUrl = (c: Competitor, port: number) => `http://${c}.localhost:${port}/pricing`;

/** The marketer's brief: what Plotline Studio is, and where the competitors' pages are. */
export function launchBrief(lang: DemoLang, port: number): Record<string, string> {
  const [w, p, e] = COMPETITORS.map((c) => competitorUrl(c, port));
  return {
    'LAUNCH.md': by(
      lang,
      [
        '# Plotline Studio: launch brief',
        '',
        'Plotline is a podcast recording and editing app for independent creators. Plotline Studio, our new',
        'plan, launches on 1 December.',
        '',
        '## Plotline Studio, USD 12 a month',
        '',
        '- Record up to 8 remote guests, each on a track of their own, in 48 kHz audio.',
        '- Transcripts in 30 languages, made while you record; cut the audio by editing the text.',
        '- Unlimited recording hours and storage.',
        '- Publishes straight to the podcast directories.',
        '',
        'For hosts who interview remote guests, one to four episodes a month.',
        '',
        '## Competitors’ pricing pages',
        '',
        `- Wavecut: ${w}`,
        `- Podforge: ${p}`,
        `- Echoroom: ${e}`,
        '',
        'Tone: plain and confident, no exclamation marks.',
        '',
      ],
      [
        '# Plotline Studio：上市簡報',
        '',
        'Plotline 是給獨立創作者用的 podcast 錄音與剪輯 app。新方案 Plotline Studio 將在 12 月 1 日上市。',
        '',
        '## Plotline Studio，每月 NT$390',
        '',
        '- 最多 8 位遠端來賓同時錄音，每人一軌，48 kHz 音質。',
        '- 錄音的同時產生 30 種語言的逐字稿；改文字就能剪音檔。',
        '- 錄音時數與儲存空間不限。',
        '- 直接發布到各大 podcast 平台。',
        '',
        '對象：會訪問遠端來賓的主持人，每月一到四集。',
        '',
        '## 競品的價格頁',
        '',
        `- Wavecut：${w}`,
        `- Podforge：${p}`,
        `- Echoroom：${e}`,
        '',
        '語氣：平實、有自信，不用驚嘆號。',
        '',
      ],
    ).join('\n'),
  };
}

interface Plan {
  name: string;
  price: string;
  points: string[];
}

interface Site {
  name: string;
  tagline: string;
  plans: Plan[];
  faq: [string, string][];
}

const SITES: Record<DemoLang, Record<Competitor, Site>> = {
  en: {
    wavecut: {
      name: 'Wavecut',
      tagline: 'Studio-quality podcasts, from anywhere.',
      plans: [
        {
          name: 'Creator',
          price: 'USD 15 / month',
          points: ['Up to 3 remote guests', 'Transcripts in English', '10 recording hours a month'],
        },
        {
          name: 'Pro',
          price: 'USD 29 / month',
          points: ['Up to 6 remote guests', 'Transcripts in 12 languages', '30 recording hours a month', 'Separate tracks'],
        },
      ],
      faq: [
        ['Do guests need an account?', 'No: they join from a link in their browser.'],
        ['What happens over my hours?', 'Recording stops until next month, or you buy 5 more hours for USD 6.'],
      ],
    },
    podforge: {
      name: 'Podforge',
      tagline: 'Edit your podcast like a pro, in minutes.',
      plans: [
        {
          name: 'Solo',
          price: 'USD 9 / month',
          points: ['Record on your own computer (no remote guests)', 'Transcripts: USD 10 a month add-on', '5 recording hours a month'],
        },
        {
          name: 'Team',
          price: 'USD 24 / month',
          points: ['Up to 4 remote guests', 'Transcripts in 20 languages', 'Unlimited storage', '3 editors'],
        },
      ],
      faq: [
        ['Can I edit by text?', 'On the Team plan, once the transcript is ready (about an hour after recording).'],
        ['Can I publish from Podforge?', 'Export an MP3 and upload it to your host.'],
      ],
    },
    echoroom: {
      name: 'Echoroom',
      tagline: 'The remote recording room for interviews.',
      plans: [
        { name: 'Free', price: 'USD 0', points: ['1 remote guest', '2 recording hours a month', 'Echoroom watermark'] },
        {
          name: 'Plus',
          price: 'USD 19 / month',
          points: ['Up to 10 remote guests', 'Separate tracks, 48 kHz', '20 recording hours a month', 'No transcripts (see our partners)'],
        },
      ],
      faq: [
        ['Do you make transcripts?', 'Not yet: export your tracks to a transcription partner.'],
        ['Can I record video?', 'Yes, on Plus, up to 1080p.'],
      ],
    },
  },
  'zh-TW': {
    wavecut: {
      name: 'Wavecut',
      tagline: '在哪裡都能錄出錄音室等級的 podcast。',
      plans: [
        { name: 'Creator', price: '每月 NT$490', points: ['最多 3 位遠端來賓', '英文逐字稿', '每月 10 小時錄音'] },
        { name: 'Pro', price: '每月 NT$950', points: ['最多 6 位遠端來賓', '12 種語言的逐字稿', '每月 30 小時錄音', '分軌錄音'] },
      ],
      faq: [
        ['來賓需要帳號嗎？', '不需要：點連結就能在瀏覽器加入。'],
        ['錄音時數用完了怎麼辦？', '下個月才能再錄，或花 NT$190 加購 5 小時。'],
      ],
    },
    podforge: {
      name: 'Podforge',
      tagline: '幾分鐘就能像專業人士一樣剪 podcast。',
      plans: [
        {
          name: 'Solo',
          price: '每月 NT$290',
          points: ['只能在自己的電腦錄音（沒有遠端來賓）', '逐字稿：每月加購 NT$320', '每月 5 小時錄音'],
        },
        { name: 'Team', price: '每月 NT$790', points: ['最多 4 位遠端來賓', '20 種語言的逐字稿', '儲存空間不限', '3 位剪輯者'] },
      ],
      faq: [
        ['可以用文字剪輯嗎？', 'Team 方案可以，逐字稿完成後（錄完約一小時）。'],
        ['可以從 Podforge 直接發布嗎？', '請匯出 MP3，再上傳到你的託管平台。'],
      ],
    },
    echoroom: {
      name: 'Echoroom',
      tagline: '專為訪談打造的遠端錄音室。',
      plans: [
        { name: 'Free', price: 'NT$0', points: ['1 位遠端來賓', '每月 2 小時錄音', '有 Echoroom 浮水印'] },
        {
          name: 'Plus',
          price: '每月 NT$620',
          points: ['最多 10 位遠端來賓', '分軌錄音，48 kHz', '每月 20 小時錄音', '沒有逐字稿（請找合作夥伴）'],
        },
      ],
      faq: [
        ['你們有逐字稿嗎？', '還沒有：請把音軌匯出給逐字稿合作夥伴。'],
        ['可以錄影嗎？', '可以，Plus 方案最高 1080p。'],
      ],
    },
  },
};

const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** A competitor's pricing page, as the stand-in web server serves it (a made-up product: nothing on it is real). */
export function competitorPage(lang: DemoLang, c: Competitor): string {
  const s = SITES[lang][c];
  const L = by(
    lang,
    { pricing: 'Pricing', faq: 'Questions', start: 'Start free trial' },
    { pricing: '價格方案', faq: '常見問題', start: '開始免費試用' },
  );
  return [
    '<!doctype html>',
    `<html lang="${lang === 'en' ? 'en' : 'zh-Hant-TW'}">`,
    '<head><meta charset="utf-8" />',
    `<title>${html(s.name)}: ${L.pricing}</title>`,
    '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1a1a1a}header,main{max-width:860px;margin:0 auto;padding:24px}',
    '.plans{display:flex;gap:16px}.plan{flex:1;border:1px solid #ddd;border-radius:12px;padding:16px}.price{font-size:24px;font-weight:700}</style>',
    '</head>',
    '<body>',
    `<header><strong>${html(s.name)}</strong> · <a href="/pricing">${L.pricing}</a></header>`,
    '<main>',
    `<h1>${html(s.tagline)}</h1>`,
    `<h2>${L.pricing}</h2>`,
    '<div class="plans">',
    ...s.plans.map(
      (p) =>
        `<section class="plan"><h3>${html(p.name)}</h3><p class="price">${html(p.price)}</p><ul>${p.points.map((x) => `<li>${html(x)}</li>`).join('')}</ul><a href="/pricing">${L.start}</a></section>`,
    ),
    '</div>',
    `<h2>${L.faq}</h2>`,
    ...s.faq.map(([q, a]) => `<h3>${html(q)}</h3><p>${html(a)}</p>`),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// --- Month-end close: Harbor Bakery's bank statement and cash ledger for October ------------------

/** Where both October files start: September was reconciled with nothing left open. */
export const BOOKS_OPENING = { en: 18_420.35, 'zh-TW': 184_204 } as const;

/**
 * October's money in and out, in USD (the Chinese files in NT$, ten times as much, in whole dollars).
 * `bank` and `ledger` say which side has it: what only one side has is a difference to find.
 */
const OCTOBER: {
  day: number;
  en: string;
  zh: string;
  amount: number;
  /** The other side's amount, where it differs (digits swapped in the ledger). */
  ledgerAmount?: number;
  only?: 'bank' | 'ledger';
  /** Entered twice in the ledger. */
  twice?: boolean;
}[] = [
  { day: 1, en: 'Card sales', zh: '刷卡收入', amount: 2860.4 },
  { day: 1, en: 'Rent, Pier 9 Properties', zh: '房租，九號碼頭物業', amount: -3200 },
  { day: 2, en: 'Flour Mill Supply, invoice 2291', zh: '麵粉廠供應，發票 2291', amount: -1840, twice: true },
  { day: 3, en: 'Card sales', zh: '刷卡收入', amount: 2415.75 },
  { day: 5, en: 'Payroll', zh: '薪資', amount: -6980 },
  { day: 6, en: 'Card sales', zh: '刷卡收入', amount: 3102.2 },
  { day: 7, en: 'Green Valley Produce', zh: '綠谷蔬果', amount: -486.3 },
  { day: 8, en: 'Harbor Electric', zh: '港灣電力', amount: -451.6, ledgerAmount: -415.6 },
  { day: 9, en: 'Card sales', zh: '刷卡收入', amount: 2288.9 },
  { day: 10, en: 'Blackbird Roasters', zh: '黑鳥咖啡烘焙', amount: -912 },
  { day: 12, en: 'Card sales', zh: '刷卡收入', amount: 3540.1 },
  { day: 13, en: 'Coastline Mutual, insurance', zh: '海岸互助保險', amount: -640 },
  { day: 14, en: 'Bright Meadow Dairy', zh: '晴草乳品', amount: -733.45 },
  { day: 15, en: 'Catering deposit, Lin wedding', zh: '外燴訂金，林府喜宴', amount: 1500 },
  { day: 16, en: 'Card sales', zh: '刷卡收入', amount: 2977.65 },
  { day: 19, en: 'Payroll', zh: '薪資', amount: -6980 },
  { day: 20, en: 'Card sales', zh: '刷卡收入', amount: 3215.3 },
  { day: 21, en: 'Boxwell Packaging', zh: '盒好包裝', amount: -388.2 },
  { day: 22, en: 'Flour Mill Supply, invoice 2318', zh: '麵粉廠供應，發票 2318', amount: -1912.5 },
  { day: 23, en: 'Card sales', zh: '刷卡收入', amount: 2654.8 },
  { day: 26, en: 'Card sales', zh: '刷卡收入', amount: 3390.45 },
  { day: 27, en: 'City Water', zh: '自來水費', amount: -142.8 },
  { day: 28, en: 'Oven Pros, repair', zh: '烤箱專家，維修', amount: -1075 },
  { day: 29, en: 'Cheque 1047, Green Valley Produce', zh: '支票 1047，綠谷蔬果', amount: -620, only: 'ledger' },
  { day: 30, en: 'Card sales', zh: '刷卡收入', amount: 2840.15 },
  { day: 31, en: 'Weekend card sales', zh: '週末刷卡收入', amount: 3280.5, only: 'ledger' },
  { day: 31, en: 'Monthly service fee', zh: '月服務費', amount: -35, only: 'bank' },
  { day: 31, en: 'Card terminal fees, October', zh: '刷卡機手續費，10 月', amount: -268.42, only: 'bank' },
];

/** USD with cents, or NT$ (ten times as much) in whole dollars. */
const money = (lang: DemoLang, usd: number) => (lang === 'en' ? usd.toFixed(2) : String(Math.round(usd * 10)));
const csvField = (s: string) => (/[,"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

/** The bank's statement and the bakery's cash ledger for October 2026, as CSV files: file name → text. */
export function bakeryBooks(lang: DemoLang): Record<string, string> {
  const date = (day: number) => `2026-10-${String(day).padStart(2, '0')}`;
  const H = by(
    lang,
    { bank: 'date,description,amount,balance', ledger: 'date,entry,memo,account,amount', opening: 'Opening balance', cash: 'Cash at bank' },
    { bank: '日期,摘要,金額,餘額', ledger: '日期,傳票,摘要,科目,金額', opening: '期初餘額', cash: '銀行存款' },
  );
  const cents = (s: string) => Math.round(Number(s) * 100);
  let balance = cents(money(lang, BOOKS_OPENING.en));
  const bank = [H.bank, `${date(1)},${H.opening},,${money(lang, BOOKS_OPENING.en)}`];
  for (const t of OCTOBER) {
    if (t.only === 'ledger') continue;
    const amount = money(lang, t.amount);
    balance += cents(amount);
    bank.push([date(t.day), csvField(by(lang, t.en, t.zh)), amount, (balance / 100).toFixed(lang === 'en' ? 2 : 0)].join(','));
  }
  const ledger = [H.ledger];
  let entry = 5100;
  const row = (day: number, memo: string, amount: number) =>
    ledger.push([date(day), `JE-${entry++}`, csvField(memo), H.cash, money(lang, amount)].join(','));
  row(1, H.opening, BOOKS_OPENING.en);
  for (const t of OCTOBER) {
    if (t.only === 'bank') continue;
    row(t.day, by(lang, t.en, t.zh), t.ledgerAmount ?? t.amount);
    if (t.twice) row(t.day + 2, by(lang, t.en, t.zh), t.amount);
  }
  return {
    [by(lang, 'bank-statement-2026-10.csv', '銀行對帳單-2026-10.csv')]: bank.join('\n') + '\n',
    [by(lang, 'cash-ledger-2026-10.csv', '現金帳-2026-10.csv')]: ledger.join('\n') + '\n',
  };
}

/** What the accountant's folder holds about the bakery. */
export function bakeryNotes(lang: DemoLang): Record<string, string> {
  return {
    'README.md': by(
      lang,
      '# Harbor Bakery: month-end close\n\nOctober 2026, in USD. September was reconciled with nothing left open: both files start at 18,420.35.\n',
      '# 港邊烘焙坊：月結\n\n2026 年 10 月，金額單位為新台幣。9 月已對帳完成、沒有未結項目：兩份檔案都從 184,204 開始。\n',
    ),
  };
}

// --- Collecting payments: the overdue invoices, and the mail about them --------------------------

/** The account the studio's mail is read from, on the stand-in mail server. */
export const ME = { name: 'Alex Rivera', address: 'alex@lumenoak.example', user: 'alex@lumenoak.example', pass: 'demo-app-password' };

/** A header value, as an encoded word when it is not ASCII. */
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const person = (name: string, address: string) => `${header(name)} <${address}>`;

interface Mail {
  from: [string, string];
  subject: string;
  body: string;
  sent: Date;
}

/** A message as the IMAP server sends it: UTF-8 bytes in a latin1 string, as the stand-in server keeps them. */
function raw(uid: number, m: Mail): { uid: number; raw: string } {
  const text = [
    `Date: ${m.sent.toUTCString().replace('GMT', '+0000')}`,
    `From: ${person(...m.from)}`,
    `To: ${person(ME.name, ME.address)}`,
    `Subject: ${header(m.subject)}`,
    `Message-ID: <studio-${uid}@lumenoak.example>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    m.body.replace(/\n/g, '\r\n'),
  ].join('\r\n');
  return { uid, raw: Buffer.from(text, 'utf8').toString('latin1') };
}

/** The studio's three overdue invoices, and who to write to about each. */
export function invoices(lang: DemoLang): Record<string, string> {
  return {
    'INVOICES.md': by(
      lang,
      [
        '# Overdue invoices',
        '',
        'Lumen & Oak Studio, interior design. Every invoice is due 30 days after it is sent; clients pay by bank',
        'transfer, and the bank mails a notice for each payment.',
        '',
        '| Invoice | Client | Contact | Amount | Due |',
        '| --- | --- | --- | --- | --- |',
        '| INV-1041 | Juniper Café | Rosa Delgado <rosa@junipercafe.example> | USD 2,400.00 | 15 October 2026 |',
        '| INV-1043 | Bayside Dental | Tom Becker <tom@baysidedental.example> | USD 1,150.00 | 22 October 2026 |',
        '| INV-1046 | Paper Lantern Books | Hana Ito <hana@paperlantern.example> | USD 3,800.00 | 31 October 2026 |',
        '',
      ],
      [
        '# 逾期未付的發票',
        '',
        '光與橡木室內設計。每張發票開立後 30 天到期；客戶用銀行轉帳付款，每筆入帳銀行都會寄通知信。',
        '',
        '| 發票 | 客戶 | 聯絡人 | 金額 | 到期日 |',
        '| --- | --- | --- | --- | --- |',
        '| INV-1041 | 杜松咖啡 | 杜蘿莎 <rosa@junipercafe.example> | NT$72,000 | 2026 年 10 月 15 日 |',
        '| INV-1043 | 海灣牙醫 | 白湯姆 <tom@baysidedental.example> | NT$34,500 | 2026 年 10 月 22 日 |',
        '| INV-1046 | 紙燈籠書店 | 伊藤花 <hana@paperlantern.example> | NT$114,000 | 2026 年 10 月 31 日 |',
        '',
      ],
    ).join('\n'),
  };
}

const BANK = 'notices@harbourbank.example';

/** The mail before the first run: one invoice paid, one client asking for a plan, one silent, and one mail about something else. */
export function studioMailbox(lang: DemoLang): { uid: number; raw: string }[] {
  const en: Mail[] = [
    {
      from: ['Harbour Bank', BANK],
      subject: 'Incoming transfer: USD 2,400.00',
      body: 'You received USD 2,400.00 from JUNIPER CAFE LLC.\nReference: INV-1041\n\nThis is an automatic notice.',
      sent: at(-1, 15, 12),
    },
    {
      from: ['Tom Becker', 'tom@baysidedental.example'],
      subject: 'Re: Invoice INV-1043',
      body: 'Hi Alex,\n\nSorry this is late: our new clinic opened last month and money is tight. Could we pay half now and the other half on 30 November?\n\nTom\nBayside Dental',
      sent: at(-1, 18, 40),
    },
    {
      from: ['Willow Textiles', 'orders@willowtextiles.example'],
      subject: 'Your fabric samples have shipped',
      body: 'The 12 fabric samples you ordered have shipped and should arrive on Thursday.',
      sent: at(0, 7, 5),
    },
  ];
  const zh: Mail[] = [
    {
      from: ['港灣銀行', BANK],
      subject: '入帳通知：NT$72,000',
      body: '您收到一筆 NT$72,000 的匯款，匯款人：杜松咖啡有限公司。\n附言：INV-1041\n\n此為系統自動通知。',
      sent: at(-1, 15, 12),
    },
    {
      from: ['白湯姆', 'tom@baysidedental.example'],
      subject: 'Re: 發票 INV-1043',
      body: 'Alex 你好：\n\n抱歉晚了：我們上個月新診所開幕，資金比較緊。可以先付一半，另一半 11 月 30 日再付嗎？\n\n湯姆\n海灣牙醫',
      sent: at(-1, 18, 40),
    },
    {
      from: ['柳枝布料', 'orders@willowtextiles.example'],
      subject: '你的布料樣品已出貨',
      body: '你訂的 12 塊布料樣品已經出貨，預計星期四送達。',
      sent: at(0, 7, 5),
    },
  ];
  return by(lang, en, zh).map((m, i) => raw(i + 1, m));
}

/** What comes in before the second run: the first half from Bayside Dental, and a date from Paper Lantern Books. */
export function studioLaterMail(lang: DemoLang): { uid: number; raw: string }[] {
  const en: Mail[] = [
    {
      from: ['Harbour Bank', BANK],
      subject: 'Incoming transfer: USD 575.00',
      body: 'You received USD 575.00 from BAYSIDE DENTAL PLLC.\nReference: INV-1043 (1 of 2)\n\nThis is an automatic notice.',
      sent: at(0, 10, 2),
    },
    {
      from: ['Hana Ito', 'hana@paperlantern.example'],
      subject: 'Re: Invoice INV-1046',
      body: 'Hi Alex,\n\nSo sorry, your invoice got lost in our end-of-month pile. We will pay the full USD 3,800.00 on 28 November; our accountant has it scheduled.\n\nHana\nPaper Lantern Books',
      sent: at(0, 10, 47),
    },
  ];
  const zh: Mail[] = [
    {
      from: ['港灣銀行', BANK],
      subject: '入帳通知：NT$17,250',
      body: '您收到一筆 NT$17,250 的匯款，匯款人：海灣牙醫診所。\n附言：INV-1043（第 1 期，共 2 期）\n\n此為系統自動通知。',
      sent: at(0, 10, 2),
    },
    {
      from: ['伊藤花', 'hana@paperlantern.example'],
      subject: 'Re: 發票 INV-1046',
      body: 'Alex 你好：\n\n非常抱歉，你的發票被壓在月底的文件堆裡了。我們會在 11 月 28 日付清 NT$114,000，會計已經排好了。\n\n伊藤花\n紙燈籠書店',
      sent: at(0, 10, 47),
    },
  ];
  return by(lang, en, zh).map((m, i) => raw(i + 4, m));
}

// --- A literature review: the question leadership asked -------------------------------------------

/** The researcher's brief: a company thinking about a four-day week. */
export function researchBrief(lang: DemoLang): Record<string, string> {
  return {
    'BRIEF.md': by(
      lang,
      [
        '# Brief: a four-day week pilot',
        '',
        'We are a software company of 200 people: 120 in engineering, 50 in customer support, 30 in sales and',
        'operations. HR proposes a six-month pilot of a four-day week (32 hours, the same pay) from April.',
        '',
        'Leadership meets on Monday and asks one question: what does the research say? In particular:',
        '',
        '- Does output hold up, or fall?',
        '- What happens to burnout, sick days and people leaving?',
        '- How do teams that serve customers every day, like our support team, make it work?',
        '',
      ],
      [
        '# 簡報：四天工作週試行',
        '',
        '我們是一家 200 人的軟體公司：工程 120 人、客服 50 人、業務與營運 30 人。人資提議從 4 月起試行六個月的四天工作週（每週 32 小時，薪水不變）。',
        '',
        '主管會議在星期一，只問一個問題：研究怎麼說？特別是：',
        '',
        '- 產出能維持，還是會下降？',
        '- 過勞、病假和離職會怎樣？',
        '- 每天都要服務客戶的團隊（像我們的客服）怎麼做到？',
        '',
      ],
    ).join('\n'),
  };
}

// --- A quiz: the chapter a teacher attaches -------------------------------------------------------

/** The class's folder. */
export function classNotes(lang: DemoLang): Record<string, string> {
  return {
    'README.md': by(
      lang,
      '# Science, class 8B\n\nQuizzes and answer keys for this term go in this folder.\n',
      '# 自然科，八年二班\n\n這學期的小考和解答都放在這個資料夾。\n',
    ),
  };
}

/** Chapter 5 of the science course, as the teacher attaches it: file name → text. */
export function chapter(lang: DemoLang): Record<string, string> {
  const en = [
    '# Chapter 5: Photosynthesis',
    '',
    'Plants make their own food. In **photosynthesis**, a plant uses the energy of light to turn carbon dioxide',
    'and water into glucose, a sugar, and gives off oxygen:',
    '',
    '> carbon dioxide + water → (light) → glucose + oxygen',
    '',
    '## Where it happens',
    '',
    'Photosynthesis happens in **chloroplasts**, mostly in the cells of leaves. Chloroplasts hold **chlorophyll**,',
    'a green pigment that absorbs red and blue light and reflects green light, which is why leaves look green.',
    '',
    'Carbon dioxide enters the leaf through tiny openings called **stomata**, usually on the underside of the',
    'leaf. Water comes up from the roots through the stem in tubes called **xylem**.',
    '',
    '## What the plant does with glucose',
    '',
    'A plant uses some glucose at once for energy, in **respiration**, which goes on day and night. It builds',
    'the rest into **starch** to store, and into cellulose for its cell walls.',
    '',
    '## What changes the rate',
    '',
    'Photosynthesis goes faster with more light, more carbon dioxide and a warmer temperature, but only up to a',
    'point: when one of them runs short, it limits the rate however much there is of the others. Above about',
    '40 °C the enzymes that do the work stop working well, and the rate falls.',
    '',
    '## Why it matters',
    '',
    'Almost every food chain starts with photosynthesis, and it puts back into the air the oxygen that animals',
    'and plants use in respiration.',
    '',
  ];
  const zh = [
    '# 第五章　光合作用',
    '',
    '植物會自己製造養分。在**光合作用**中，植物利用光的能量，把二氧化碳和水變成葡萄糖（一種糖），並放出氧氣：',
    '',
    '> 二氧化碳 + 水 →（光）→ 葡萄糖 + 氧氣',
    '',
    '## 在哪裡進行',
    '',
    '光合作用在**葉綠體**中進行，大多在葉子的細胞裡。葉綠體含有**葉綠素**，這種綠色色素會吸收紅光和藍光、反射綠光，所以葉子看起來是綠色的。',
    '',
    '二氧化碳從葉子上叫做**氣孔**的小開口進入，氣孔通常在葉子背面。水從根部經由莖裡叫做**木質部**的管子往上運送。',
    '',
    '## 植物怎麼使用葡萄糖',
    '',
    '植物會立刻用掉一部分葡萄糖，透過**呼吸作用**取得能量；呼吸作用白天晚上都在進行。其餘的葡萄糖會合成**澱粉**儲存起來，或做成構成細胞壁的纖維素。',
    '',
    '## 什麼會改變速率',
    '',
    '光越強、二氧化碳越多、溫度越高，光合作用就越快，但只到某個程度：其中一項不足時，其他再多也會被它限制住。溫度超過約 40 °C，負責反應的酵素就無法正常運作，速率會下降。',
    '',
    '## 為什麼重要',
    '',
    '幾乎每一條食物鏈都從光合作用開始，它也把動植物呼吸作用用掉的氧氣補回空氣中。',
    '',
  ];
  return { [by(lang, 'chapter-5-photosynthesis.md', '第五章-光合作用.md')]: by(lang, en, zh).join('\n') };
}

// --- A contract review: a vendor's draft, and the company's playbook ------------------------------

const CONTRACT: Record<DemoLang, string[]> = {
  en: [
    '# Software Services Agreement',
    '',
    'Between **Cloudmere Analytics, Inc.** (“Vendor”) and **Northfield Outdoor Co.** (“Customer”). Draft 2,',
    'as received from the Vendor on 12 November 2026.',
    '',
    '## 1. Services',
    '',
    'Vendor provides the Cloudmere sales analytics service (the “Service”) to Customer as described in Order',
    'Form 1, with 99.5 % monthly availability.',
    '',
    '## 2. Term and renewal',
    '',
    'This Agreement starts on 1 January 2027 for an initial term of one year. It then renews automatically for',
    'successive terms of three years unless either party gives notice at least 120 days before the end of the',
    'current term.',
    '',
    '## 3. Fees',
    '',
    'Customer pays USD 48,000 a year, invoiced annually in advance. Vendor may increase the fees at any time on',
    '30 days’ notice.',
    '',
    '## 4. Payment',
    '',
    'Invoices are due within 15 days. Late amounts bear interest at 1.5 % a month.',
    '',
    '## 5. Customer Data',
    '',
    'Customer owns Customer Data. Vendor may keep Customer Data for 180 days after this Agreement ends, and may',
    'use Customer Data to improve its services.',
    '',
    '## 6. Confidentiality',
    '',
    'Each party keeps the other’s confidential information secret during this Agreement and for five years',
    'after it ends.',
    '',
    '## 7. Limitation of liability',
    '',
    'Vendor’s total liability under this Agreement is limited to the fees Customer paid in the three months',
    'before the event giving rise to the claim.',
    '',
    '## 8. Indemnity',
    '',
    'Customer will defend and indemnify Vendor against any third-party claim arising from Customer’s use of the',
    'Service.',
    '',
    '## 9. Governing law',
    '',
    'This Agreement is governed by the laws of the State of Delaware, and disputes go to the courts of',
    'Wilmington, Delaware.',
    '',
  ],
  'zh-TW': [
    '# 軟體服務合約',
    '',
    '甲方：**雲境分析股份有限公司**（以下稱「廠商」）；乙方：**北原戶外用品股份有限公司**（以下稱「客戶」）。第二版草稿，廠商於 2026 年 11 月 12 日提供。',
    '',
    '## 第一條　服務內容',
    '',
    '廠商依訂購單第 1 號，向客戶提供雲境銷售分析服務（以下稱「本服務」），每月可用率 99.5%。',
    '',
    '## 第二條　合約期間與續約',
    '',
    '本合約自 2027 年 1 月 1 日起生效，首期一年。期滿後自動續約，每次續約三年，除非任一方於當期屆滿前至少 120 日書面通知不續約。',
    '',
    '## 第三條　費用',
    '',
    '客戶每年支付新台幣 1,440,000 元，每年預先開立發票。廠商得隨時於 30 日前通知調整費用。',
    '',
    '## 第四條　付款',
    '',
    '發票應於開立後 15 日內付款。逾期款項按每月 1.5% 計息。',
    '',
    '## 第五條　客戶資料',
    '',
    '客戶資料屬客戶所有。本合約終止後，廠商得保留客戶資料 180 日，並得使用客戶資料改善其服務。',
    '',
    '## 第六條　保密',
    '',
    '雙方於合約期間及合約終止後五年內，應對他方之機密資訊保密。',
    '',
    '## 第七條　責任限制',
    '',
    '廠商依本合約所負之全部賠償責任，以請求事由發生前三個月內客戶已支付之費用為上限。',
    '',
    '## 第八條　賠償',
    '',
    '因客戶使用本服務而生之第三人請求，客戶應為廠商進行防禦並負賠償責任。',
    '',
    '## 第九條　準據法與管轄',
    '',
    '本合約以新加坡法律為準據法，爭議提交新加坡國際仲裁中心仲裁。',
    '',
  ],
};

const PLAYBOOK: Record<DemoLang, string[]> = {
  en: [
    '# Contract playbook: software we buy',
    '',
    'Northfield Outdoor Co., legal team. What we accept from a vendor, clause by clause. “Must” is a red line;',
    '“should” we may trade away with a reason.',
    '',
    '- **Renewal.** Must renew for one year at a time at most. Notice to stop renewing must be 60 days or less.',
    '- **Fee increases.** Must be at most once a year, at most 5 %, on at least 60 days’ notice.',
    '- **Payment.** Should be within 30 days. Late interest must be 1 % a month or less.',
    '- **Customer data.** Must be returned or deleted within 30 days after the agreement ends. The vendor may',
    '  use it to improve its services only once it is anonymised and aggregated.',
    '- **Confidentiality.** At least three years after the agreement ends.',
    '- **Liability cap.** Must be at least the fees of the 12 months before the claim. Must not cap a breach of',
    '  confidentiality or of data protection.',
    '- **Indemnity.** Must be mutual: the vendor indemnifies us against claims that the service infringes',
    '  someone’s rights.',
    '- **Governing law.** Should be Oregon law and the courts of Portland, Oregon; Delaware is acceptable if the',
    '  vendor insists.',
    '',
  ],
  'zh-TW': [
    '# 合約審閱準則：採購軟體',
    '',
    '北原戶外用品股份有限公司，法務部。我們可接受的廠商條款，逐條列出。「必須」是底線；「應」可以附理由讓步。',
    '',
    '- **續約。** 每次續約必須最多一年。不續約的通知期必須在 60 日以內。',
    '- **調整費用。** 必須每年最多一次、漲幅最多 5%，並至少 60 日前通知。',
    '- **付款。** 應為 30 日內。逾期利息必須每月 1% 以下。',
    '- **客戶資料。** 必須在合約終止後 30 日內返還或刪除。廠商只能在資料去識別化並彙總之後，用來改善其服務。',
    '- **保密。** 合約終止後至少三年。',
    '- **責任上限。** 必須至少為請求事由發生前 12 個月的費用。違反保密或個人資料保護的責任不得設上限。',
    '- **賠償。** 必須雙向：服務侵害他人權利而生的請求，由廠商賠償我們。',
    '- **準據法與管轄。** 應以中華民國法律為準據法，並以臺灣臺北地方法院為第一審管轄法院；廠商堅持時，可接受以新加坡國際仲裁中心仲裁。',
    '',
  ],
};

/** vendor-contract: the vendor's draft and the playbook, committed as they came, so that every edit shows as a change to it. */
export function vendorContract(dir: string, lang: DemoLang): void {
  init(dir);
  commit(
    dir,
    by(lang, 'Draft 2 from Cloudmere, and our playbook', '雲境的第二版草稿，以及我們的審閱準則'),
    ANA('2026-11-12T16:20:00+08:00'),
    {
      'contract.md': CONTRACT[lang].join('\n'),
      'playbook.md': PLAYBOOK[lang].join('\n'),
    },
  );
}

// --- An alert: the checkout service's logs, deploys and runbook -----------------------------------

/** A time today, as the logs write it: local time with its offset. */
function stampAt(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const zone = `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${zone}`;
}

/**
 * checkout-service: an hour of its log, around the deploy at 14:02 that put payment calls on a pool of
 * ten connections; from 14:04 the pool runs out and checkouts fail. A slow cart query is there before and
 * after, and has nothing to do with it.
 */
export function checkoutService(dir: string, lang: DemoLang): void {
  const rand = random(2026_11_18);
  const entries: { t: number; line: string }[] = [];
  const log = (t: number, level: string, text: string) => entries.push({ t, line: `${stampAt(new Date(t))} ${level.padEnd(5)} ${text}` });
  const start = at(0, 13, 30).getTime();
  const deploy = at(0, 14, 2).getTime();
  const end = at(0, 14, 21).getTime();
  log(deploy, 'INFO', 'deploy: checkout v2.31.0 starting (3 instances)');
  log(deploy + 41_000, 'INFO', 'deploy: checkout v2.31.0 healthy on 3/3 instances');
  log(deploy + 41_500, 'INFO', 'payments: connection pool ready (max 10 connections per instance)');
  for (let t = start; t < end; t += 4_000 + Math.floor(rand() * 9_000)) {
    const when = t + Math.floor(rand() * 1000);
    const r = rand();
    const order = `ord_${Math.floor(100000 + rand() * 899999)}`;
    // From two minutes after the deploy, more and more payment calls wait for the pool and time out.
    const failing = when > deploy + 120_000 ? Math.min(0.32, (when - deploy) / 2_400_000) : 0;
    if (r < 0.06) log(when, 'WARN', `carts: slow query cart_totals ${Math.floor(800 + rand() * 600)}ms`);
    else if (r < 0.06 + failing) {
      const waiting = Math.floor(12 + rand() * 40);
      log(
        when,
        'ERROR',
        `payments: timed out after 5000ms waiting for a connection from the pool (10/10 in use, ${waiting} waiting) ${order}`,
      );
      log(when + 3, 'ERROR', `POST /checkout 502 5012ms ${order}`);
    } else log(when, 'INFO', `POST /checkout 200 ${Math.floor(140 + rand() * 260)}ms ${order}`);
  }
  const lines = entries.sort((a, b) => a.t - b.t).map((e) => e.line);
  const time = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  writeAll(dir, {
    [`logs/checkout-${stampAt(at(0, 0)).slice(0, 10)}.log`]: lines.join('\n') + '\n',
    'DEPLOYS.md': by(
      lang,
      [
        '# Deploys',
        '',
        '| When | Service | Version | Change | By |',
        '| --- | --- | --- | --- | --- |',
        `| today ${time(14, 2)} | checkout | v2.31.0 | Reuse connections to the payment provider: a pool of 10 per instance instead of a new connection per request | Mei Chen |`,
        `| today ${time(11, 40)} | cart | v1.9.2 | Cache cart totals for 30 seconds | Ken Watanabe |`,
        `| yesterday ${time(17, 15)} | checkout | v2.30.4 | Fix the wording on the order confirmation page | Ana Lima |`,
        '',
      ],
      [
        '# 部署紀錄',
        '',
        '| 時間 | 服務 | 版本 | 變更 | 部署者 |',
        '| --- | --- | --- | --- | --- |',
        `| 今天 ${time(14, 2)} | checkout | v2.31.0 | 重複使用與金流商的連線：每個執行個體改用 10 條連線的連線池，不再每個請求開新連線 | 陳美 |`,
        `| 今天 ${time(11, 40)} | cart | v1.9.2 | 購物車總額快取 30 秒 | 渡邊健 |`,
        `| 昨天 ${time(17, 15)} | checkout | v2.30.4 | 修正訂單確認頁的文字 | 林安娜 |`,
        '',
      ],
    ).join('\n'),
    'RUNBOOK.md': by(
      lang,
      [
        '# Runbook: checkout',
        '',
        '## CheckoutErrorRate',
        '',
        'Fires when more than 1 % of checkouts fail for 5 minutes.',
        '',
        '1. If a deploy in the last hour changed checkout, roll it back first: `deployctl rollback checkout`.',
        '   Investigate afterwards.',
        '2. If the errors name the payment provider, page the payments team (#payments-oncall).',
        '3. Post in #incidents what you saw and what you did.',
        '',
      ],
      [
        '# 處理手冊：checkout',
        '',
        '## CheckoutErrorRate',
        '',
        '結帳失敗率連續 5 分鐘超過 1% 時觸發。',
        '',
        '1. 如果一小時內有部署改到 checkout，先回滾：`deployctl rollback checkout`，之後再調查。',
        '2. 如果錯誤提到金流商，呼叫金流團隊（#payments-oncall）。',
        '3. 在 #incidents 貼上你看到的狀況和做了什麼。',
        '',
      ],
    ).join('\n'),
  });
}

/** What the monitoring system posts to the webhook when the alert fires. */
export function checkoutAlert(): Record<string, string> {
  return {
    alert: 'CheckoutErrorRate',
    status: 'firing',
    severity: 'page',
    service: 'checkout',
    summary: '7.8% of checkouts failed in the last 5 minutes (threshold 1%)',
    startsAt: stampAt(at(0, 14, 9)),
  };
}

// --- A design review: three sign-up screens of a plant-care app -----------------------------------

/** The screens' size, a phone's, in CSS pixels (saved at twice that). */
export const SCREEN = { width: 390, height: 844 };

/**
 * Fernway's three sign-up screens, as HTML to take a screenshot of: file name → page. Each has the problems
 * a review should find: grey text too faint to read, a tiny Skip, labels only as placeholders, a button that
 * looks disabled, an error said only in red and in a code, and two buttons that do not match.
 */
export function signupScreens(lang: DemoLang): Record<string, string> {
  const T = by(
    lang,
    {
      file: ['signup-1-welcome.png', 'signup-2-form.png', 'signup-3-error.png'],
      skip: 'Skip',
      hello: 'Every plant, thriving',
      sub: 'Fernway reminds you when to water, feed and repot each of your plants, and tells you why a leaf turns yellow.',
      start: 'Get started',
      have: 'I already have an account',
      title: 'Create your account',
      name: 'Full name',
      email: 'Email',
      pass: 'Password',
      terms: 'I agree to the Terms and the Privacy Policy',
      create: 'Create account',
      or: 'or',
      google: 'Continue with Google',
      error: 'Error 422: invalid input',
      typed: 'sam.lee@mail',
    },
    {
      file: ['註冊-1-歡迎.png', '註冊-2-表單.png', '註冊-3-錯誤.png'],
      skip: '略過',
      hello: '每一盆植物，都長得好',
      sub: 'Fernway 會提醒你每盆植物該澆水、施肥和換盆的時間，也告訴你葉子為什麼變黃。',
      start: '開始使用',
      have: '我已經有帳號',
      title: '建立帳號',
      name: '姓名',
      email: '電子郵件',
      pass: '密碼',
      terms: '我同意服務條款與隱私權政策',
      create: '建立帳號',
      or: '或',
      google: '使用 Google 帳號繼續',
      error: '錯誤 422：輸入無效',
      typed: 'sam.lee@mail',
    },
  );
  const page = (body: string) =>
    [
      '<!doctype html>',
      `<html lang="${lang === 'en' ? 'en' : 'zh-Hant-TW'}"><head><meta charset="utf-8" /><style>`,
      `body{margin:0;width:${SCREEN.width}px;height:${SCREEN.height}px;font:15px/1.45 -apple-system,"PingFang TC","Noto Sans TC",system-ui,sans-serif;background:#fff;color:#2b2b2b;overflow:hidden}`,
      '.bar{height:44px}.wrap{padding:0 28px}.skip{position:absolute;top:54px;right:20px;font-size:10px;color:#c4c4c4}',
      '.leaf{height:330px;margin:20px 0 28px;border-radius:28px;background:radial-gradient(circle at 30% 30%,#cfe8c4,#7fb36a 60%,#4f7d3f)}',
      'h1{font-size:28px;margin:0 0 10px}.faint{color:#b9b9b9}.btn{display:block;text-align:center;border-radius:14px;padding:15px;font-weight:600}',
      '.go{background:#2f7d4a;color:#fff;margin-top:28px}.ghost{color:#2f7d4a;margin-top:6px;font-size:13px}',
      '.field{border:1px solid #e6e6e6;border-radius:10px;padding:14px;margin:12px 0;color:#c8c8c8}',
      '.field.typed{color:#2b2b2b}.field.bad{border-color:#e5484d}.pale{background:#cfe3d4;color:#fff;margin-top:20px}',
      '.terms{font-size:11px;color:#b9b9b9;margin-top:6px}.or{text-align:center;color:#c8c8c8;margin:14px 0;font-size:12px}',
      '.google{border:2px solid #1a1a1a;border-radius:4px;padding:11px;text-align:center;font-weight:700;letter-spacing:.02em}',
      '.err{color:#e5484d;font-size:12px;margin:-6px 0 0}',
      '</style></head><body><div class="bar"></div>',
      body,
      '</body></html>',
      '',
    ].join('\n');
  const form = (email: string, bad: boolean) =>
    [
      `<div class="wrap"><h1 style="margin-top:36px">${T.title}</h1>`,
      `<div class="field">${T.name}</div>`,
      `<div class="field${bad ? ' typed bad' : ''}">${email || T.email}</div>`,
      bad ? `<p class="err">${T.error}</p>` : '',
      `<div class="field">${T.pass}</div>`,
      `<div class="terms">☐ ${T.terms}</div>`,
      `<div class="btn pale">${T.create}</div>`,
      `<div class="or">${T.or}</div>`,
      `<div class="google">${T.google}</div></div>`,
    ].join('\n');
  return {
    [T.file[0]!]: page(
      [
        `<div class="skip">${T.skip}</div>`,
        '<div class="wrap"><div class="leaf"></div>',
        `<h1>${T.hello}</h1><p class="faint">${T.sub}</p>`,
        `<div class="btn go">${T.start}</div><div class="btn ghost">${T.have}</div></div>`,
      ].join('\n'),
    ),
    [T.file[1]!]: page(form('', false)),
    [T.file[2]!]: page(form(T.typed, true)),
  };
}
