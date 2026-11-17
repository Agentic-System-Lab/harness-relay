/**
 * The folders the use cases run in, made fresh for each recording: small projects, a git history, a
 * spreadsheet, and a mailbox and calendar for the stand-in mail servers. Everything in them is made up
 * (people, companies, numbers), and the same every time: the spreadsheet comes from a seeded generator.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DemoLang } from '../common';

/** Writes `files` (path → text) under `dir`. */
function writeAll(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

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
const KEN = (date: string): Who => ({ name: 'Ken Watanabe', email: 'ken@example.com', date });
const MEI = (date: string): Who => ({ name: 'Mei Chen', email: 'mei@example.com', date });

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

// --- Write as a relay: pocket-budget's history since v1.3.0 --------------------------------------

const BUDGET_PACKAGE = (version: string, node: string) =>
  JSON.stringify(
    {
      name: 'pocket-budget',
      version,
      description: 'Track a household budget from your bank’s CSV files, in the terminal.',
      type: 'module',
      bin: { 'pocket-budget': 'src/cli.js' },
      scripts: { test: 'node --test' },
      engines: { node },
      license: 'MIT',
    },
    null,
    2,
  ) + '\n';

const BUDGET_PARSE_INLINE = [
  "import { readFileSync } from 'node:fs';",
  '',
  '/** Reads a bank CSV file (date,description,amount,category) into transactions. */',
  'export function importFile(path) {',
  "  const lines = readFileSync(path, 'utf8').trim().split('\\n').slice(1);",
  '  return lines.map((line) => {',
  '    const [date, description, amount, category] = line.split(/[,\\s]+/);',
  '    return { date, description, amount: Number(amount), category };',
  '  });',
  '}',
  '',
].join('\n');

const BUDGET_PARSE_QUOTED = [
  "import { readFileSync } from 'node:fs';",
  '',
  '/** One CSV line into its fields; a field in double quotes may hold commas and spaces. */',
  'function fields(line) {',
  '  const out = [];',
  '  for (const m of line.matchAll(/"([^"]*)"|([^,]+)|(?<=,)(?=,|$)/g)) out.push((m[1] ?? m[2] ?? \'\').trim());',
  '  return out;',
  '}',
  '',
  '/** Reads a bank CSV file (date,description,amount,category) into transactions. */',
  'export function importFile(path) {',
  "  const lines = readFileSync(path, 'utf8').trim().split('\\n').slice(1);",
  '  return lines.map((line) => {',
  '    const [date, description, amount, category] = fields(line);',
  '    return { date, description, amount: Number(amount), category };',
  '  });',
  '}',
  '',
].join('\n');

const BUDGET_PARSE_STREAM = [
  "import { createReadStream } from 'node:fs';",
  "import { createInterface } from 'node:readline';",
  "import { fields } from './csv.js';",
  '',
  '/**',
  ' * Reads a bank CSV file (date,description,amount,category) into transactions, a line at a time,',
  ' * so a large file never has to fit in memory.',
  ' */',
  'export async function importFile(path) {',
  '  const out = [];',
  '  let header = true;',
  '  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {',
  '    if (header || !line.trim()) {',
  '      header = false;',
  '      continue;',
  '    }',
  '    const [date, description, amount, category] = fields(line);',
  '    out.push({ date, description, amount: Number(amount), category });',
  '  }',
  '  return out;',
  '}',
  '',
].join('\n');

const BUDGET_CSV = [
  '/** One CSV line into its fields; a field in double quotes may hold commas and spaces. */',
  'export function fields(line) {',
  '  const out = [];',
  '  for (const m of line.matchAll(/"([^"]*)"|([^,]+)|(?<=,)(?=,|$)/g)) out.push((m[1] ?? m[2] ?? \'\').trim());',
  '  return out;',
  '}',
  '',
].join('\n');

const BUDGET_REPORT = (withMonth: boolean, cents: boolean, csv = true) =>
  [
    '/** Spending by category, largest first. */',
    `export function report(transactions${withMonth ? ', { month } = {}' : ''}) {`,
    '  const totals = new Map();',
    '  for (const t of transactions) {',
    ...(withMonth ? ['    if (month && !t.date.startsWith(month)) continue;'] : []),
    '    totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);',
    '  }',
    '  return [...totals].sort((a, b) => a[1] - b[1]);',
    '}',
    '',
    ...(csv
      ? [
          '/** The report as CSV, for a spreadsheet. */',
          'export function reportCsv(rows) {',
          `  return ['category,total', ...rows.map(([c, total]) => \`\${c},\${${cents ? 'total.toFixed(2)' : 'total'}}\`)].join('\\n');`,
          '}',
          '',
        ]
      : []),
  ].join('\n');

const BUDGET_I18N = (langs: ('de' | 'nl')[]) =>
  [
    'export const messages = {',
    "  en: { total: 'Total', imported: (n) => `Imported ${n} transactions` },",
    ...(langs.includes('de') ? ["  de: { total: 'Summe', imported: (n) => `${n} Buchungen importiert` },"] : []),
    ...(langs.includes('nl') ? ["  nl: { total: 'Totaal', imported: (n) => `${n} transacties geïmporteerd` },"] : []),
    '};',
    '',
  ].join('\n');

const BUDGET_CLI = (withMonth: boolean, awaitImport: boolean, csv = true) =>
  [
    '#!/usr/bin/env node',
    "import { importFile } from './import.js';",
    `import { report${csv ? ', reportCsv' : ''} } from './report.js';`,
    '',
    'const [command, file, ...rest] = process.argv.slice(2);',
    ...(withMonth ? ["const month = rest[rest.indexOf('--month') + 1];"] : []),
    "if (command === 'report') {",
    `  const rows = report(${awaitImport ? 'await ' : ''}importFile(file)${withMonth ? ', { month }' : ''});`,
    csv
      ? "  console.log(rest.includes('--csv') ? reportCsv(rows) : rows.map(([c, t]) => `${c}: ${t}`).join('\\n'));"
      : "  console.log(rows.map(([c, t]) => `${c}: ${t}`).join('\\n'));",
    '} else {',
    `  console.log('Usage: pocket-budget report <bank.csv>${csv ? ' [--csv]' : ''}${withMonth ? ' [--month YYYY-MM]' : ''}');`,
    '}',
    '',
  ].join('\n');

/** pocket-budget: a small CLI with its history from 1.2.0 to the commits after v1.3.0 that 1.4.0 will ship. */
export function pocketBudget(dir: string): void {
  init(dir);
  commit(dir, 'Track spending by category from a bank CSV file', KEN('2026-08-04T09:30:00+08:00'), {
    'package.json': BUDGET_PACKAGE('1.2.0', '>=18'),
    'README.md':
      '# pocket-budget\n\nTrack a household budget from your bank’s CSV files, in the terminal.\n\n```\npocket-budget report bank.csv\n```\n',
    'src/import.js': BUDGET_PARSE_INLINE,
    'src/report.js': BUDGET_REPORT(false, false, false),
    'src/cli.js': BUDGET_CLI(false, false, false),
    'src/i18n.js': BUDGET_I18N([]),
  });
  git(dir, ['tag', 'v1.2.0']);
  commit(dir, 'Add a German translation', ANA('2026-09-01T14:05:00+08:00'), { 'src/i18n.js': BUDGET_I18N(['de']) });
  commit(dir, 'Add --csv to the report command, for a spreadsheet', KEN('2026-09-09T11:20:00+08:00'), {
    'src/report.js': BUDGET_REPORT(false, false),
    'src/cli.js': BUDGET_CLI(false, false),
  });
  commit(dir, 'Set the version to 1.3.0', KEN('2026-09-10T09:00:00+08:00'), { 'package.json': BUDGET_PACKAGE('1.3.0', '>=18') });
  git(dir, ['tag', 'v1.3.0']);

  // What 1.4.0 ships: what the release notes are written from.
  commit(dir, 'Add --month to the report command, to report one month only', KEN('2026-09-22T10:02:00+08:00'), {
    'src/report.js': BUDGET_REPORT(true, false),
    'src/cli.js': BUDGET_CLI(true, false),
  });
  commit(dir, 'Fix categories with spaces in them being split in two on import', MEI('2026-09-25T16:40:00+08:00'), {
    'src/import.js': BUDGET_PARSE_QUOTED,
  });
  commit(dir, 'Round totals to the cent in the CSV export', ANA('2026-10-03T09:15:00+08:00'), {
    'src/report.js': BUDGET_REPORT(true, true),
  });
  commit(dir, 'Refactor: move the CSV line parser into its own module', MEI('2026-10-08T13:00:00+08:00'), {
    'src/csv.js': BUDGET_CSV,
    'src/import.js': BUDGET_PARSE_QUOTED.replace(/\/\*\* One CSV line[\s\S]*?\n}\n\n/, '').replace(
      "import { readFileSync } from 'node:fs';\n",
      "import { readFileSync } from 'node:fs';\nimport { fields } from './csv.js';\n",
    ),
  });
  commit(dir, 'Import bank files a line at a time: a 50 MB file now takes 4 s instead of 21 s', KEN('2026-10-15T18:22:00+08:00'), {
    'src/import.js': BUDGET_PARSE_STREAM,
    'src/cli.js': BUDGET_CLI(true, true),
  });
  commit(dir, 'Add a Dutch translation', ANA('2026-10-21T10:48:00+08:00'), { 'src/i18n.js': BUDGET_I18N(['de', 'nl']) });
  commit(dir, 'Test: more import cases (quoted fields, empty lines)', MEI('2026-10-27T15:30:00+08:00'), {
    'test/import.test.js': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { fields } from '../src/csv.js';",
      '',
      "test('a quoted field keeps its commas and spaces', () => {",
      "  assert.deepEqual(fields('2026-10-01,\"Coffee, beans\",12.5,\"Food & drink\"'), ['2026-10-01', 'Coffee, beans', '12.5', 'Food & drink']);",
      '});',
      '',
    ].join('\n'),
  });
  commit(dir, 'Require Node.js 20 or later (Node.js 18 is out of support)', KEN('2026-11-03T09:05:00+08:00'), {
    'package.json': BUDGET_PACKAGE('1.3.0', '>=20'),
  });
  commit(dir, 'Docs: explain categories and the monthly report in the README', ANA('2026-11-10T17:12:00+08:00'), {
    'README.md': [
      '# pocket-budget',
      '',
      'Track a household budget from your bank’s CSV files, in the terminal.',
      '',
      '```',
      'pocket-budget report bank.csv                     # spending by category',
      'pocket-budget report bank.csv --month 2026-10     # one month only',
      'pocket-budget report bank.csv --csv > report.csv  # for a spreadsheet',
      '```',
      '',
      'Each transaction’s category is the last column of your bank’s file. A category with spaces or commas',
      'in it needs double quotes ("Food & drink").',
      '',
    ].join('\n'),
  });
  commit(dir, 'Set the version to 1.4.0', KEN('2026-11-12T11:00:00+08:00'), { 'package.json': BUDGET_PACKAGE('1.4.0', '>=20') });
}

// --- Analyze data: a quarter of support tickets ---------------------------------------------------

/** A small seeded random number generator (mulberry32): the same tickets every time. */
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

type Area = 'billing' | 'signin' | 'mobile' | 'reports' | 'other';

const AREA_NAMES: Record<DemoLang, Record<Area, string>> = {
  en: { billing: 'Billing', signin: 'Sign-in', mobile: 'Mobile app', reports: 'Reports', other: 'Other' },
  'zh-TW': { billing: '帳單', signin: '登入', mobile: '行動 App', reports: '報表', other: '其他' },
};

/** What tickets say, by area; `invoice` are the subjects that come once the new invoice layout ships. */
const SUBJECTS: Record<DemoLang, Record<Area | 'invoice', string[]>> = {
  en: {
    billing: ['Charged twice this month', 'How do I change my card?', 'Refund for unused seats', 'Plan price question'],
    invoice: ['Invoice PDF has no VAT number', 'Invoice PDF shows the wrong company address', 'Cannot download the invoice PDF'],
    signin: ['Two-factor code arrives late', 'Locked out after password reset', 'SSO sign-in loops back to the login page'],
    mobile: ['App crashes when opening a report', 'Push notifications stopped', 'Dark mode text hard to read'],
    reports: ['Export to CSV is missing columns', 'Report totals differ from the dashboard', 'Scheduled report not sent'],
    other: ['Feature request: tags', 'Question about the API limits', 'How do I add a teammate?'],
  },
  'zh-TW': {
    billing: ['本月被重複扣款', '怎麼更換信用卡？', '未使用席次的退款', '方案價格問題'],
    invoice: ['發票 PDF 沒有統一編號', '發票 PDF 上的公司地址錯誤', '無法下載發票 PDF'],
    signin: ['兩步驟驗證碼太晚收到', '重設密碼後被鎖住', 'SSO 登入一直跳回登入頁'],
    mobile: ['打開報表時 App 當掉', '推播通知不再出現', '深色模式的文字看不清楚'],
    reports: ['匯出 CSV 少了欄位', '報表總計和儀表板不一致', '排程報表沒有寄出'],
    other: ['功能建議：標籤', 'API 用量上限的問題', '怎麼加入團隊成員？'],
  },
};

const CHANNELS = ['email', 'chat', 'phone'];

/**
 * Support tickets from July to September 2026. Sign-in tickets fall once two-factor codes were fixed
 * (21 July); from 18 August, when a new invoice layout shipped, billing tickets triple, most of them about
 * the invoice PDF; and as the volume grows, the first response takes longer.
 */
export function tickets(lang: DemoLang): string {
  const rand = random(2026_07_01);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const rows = ['id,opened_at,area,channel,priority,subject,first_response_hours,resolved'];
  let id = 4100;
  const start = Date.UTC(2026, 6, 1);
  const end = Date.UTC(2026, 9, 1);
  for (let day = start; day < end; day += 86_400_000) {
    const date = new Date(day);
    const weekend = [0, 6].includes(date.getUTCDay());
    const invoiceLayout = day >= Date.UTC(2026, 7, 18);
    const twoFactorFixed = day >= Date.UTC(2026, 6, 21);
    const weights: Record<Area, number> = {
      billing: invoiceLayout ? 3.6 : 1.2,
      signin: twoFactorFixed ? 0.7 : 2.2,
      mobile: 1.3,
      reports: 0.9,
      other: 0.8,
    };
    const volume = Object.values(weights).reduce((a, b) => a + b, 0);
    const count = Math.round((weekend ? 0.45 : 1) * volume * (0.75 + rand() * 0.5));
    for (let i = 0; i < count; i++) {
      let r = rand() * volume;
      const area = (Object.keys(weights) as Area[]).find((a) => (r -= weights[a]) < 0) ?? 'other';
      const subject =
        area === 'billing' && invoiceLayout && rand() < 0.72
          ? pick(SUBJECTS[lang].invoice)
          : area === 'signin' && !twoFactorFixed && rand() < 0.6
            ? SUBJECTS[lang].signin[0]!
            : pick(SUBJECTS[lang][area]);
      const hour = 8 + Math.floor(rand() * 11);
      const minute = Math.floor(rand() * 60);
      const opened = `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const busy = Math.max(0, count - 6) * 0.9;
      const firstResponse = Math.max(0.2, (2.5 + busy) * (0.5 + rand())).toFixed(1);
      const priority = area === 'billing' && invoiceLayout ? (rand() < 0.45 ? 'high' : 'normal') : rand() < 0.18 ? 'high' : 'normal';
      const resolved = day < Date.UTC(2026, 8, 24) || rand() < 0.55 ? 'yes' : 'no';
      const quoted = /[,"]/.test(subject) ? `"${subject.replaceAll('"', '""')}"` : subject;
      rows.push([id++, opened, AREA_NAMES[lang][area], pick(CHANNELS), priority, quoted, firstResponse, resolved].join(','));
    }
  }
  return rows.join('\n') + '\n';
}

// --- A morning briefing: the mailbox and the calendar ---------------------------------------------

/** The account the briefing reads, on the stand-in servers. */
export const ME = { name: 'Alex Rivera', address: 'alex@example.com', user: 'alex@example.com', pass: 'demo-app-password' };

/** A header value, as an encoded word when it is not ASCII. */
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const person = (name: string, address: string) => `${header(name)} <${address}>`;

/** A day's date at a time, in this computer's time zone, `days` from today. */
function at(days: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

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
    `Message-ID: <briefing-${uid}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    m.body.replace(/\n/g, '\r\n'),
  ].join('\r\n');
  return { uid, raw: Buffer.from(text, 'utf8').toString('latin1') };
}

/** The mail that came in since yesterday: two that need a reply, a meeting request, a failed build, and two that need nothing. */
export function mailbox(lang: DemoLang): { uid: number; raw: string }[] {
  const weekday = (days: number) => at(days, 12).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-TW', { weekday: 'long' });
  const en: Mail[] = [
    {
      from: ['Priya Nair', 'priya@northwind.example'],
      subject: `Can we move ${weekday(2)}’s design review?`,
      body: `Hi Alex,\n\nSomething came up on our side: could we move ${weekday(2)}’s design review to later in the day, or to the morning after? Anything after 15:00 works for us.\n\nThanks,\nPriya\nNorthwind Studio`,
      sent: at(-1, 17, 42),
    },
    {
      from: ['Sam Okafor', 'sam@example.com'],
      subject: 'Q3 numbers for the board deck: today by noon?',
      body: 'Hey Alex,\n\nCould you send me the Q3 revenue and churn numbers by noon today? I’m putting the board deck together this afternoon. A rough version is fine.\n\nSam',
      sent: at(0, 7, 58),
    },
    {
      from: ['CI', 'ci@example.com'],
      subject: '[budget-app] Build failed on main: 3 tests failing',
      body: 'The build of main failed at 06:12.\n\n3 tests failing in test/import.test.js after commit 4e1c9a2 ("Import bank files a line at a time").\n\nhttps://ci.example.com/budget-app/builds/2291',
      sent: at(0, 6, 14),
    },
    {
      from: ['Lena Fischer', 'lena@example.com'],
      subject: 'Offsite planning: 30 minutes next week?',
      body: 'Hi Alex,\n\nCould we find 30 minutes next week to plan the team offsite? Mornings are best for me, except Wednesday.\n\nLena',
      sent: at(-1, 19, 5),
    },
    {
      from: ['Cloud Billing', 'billing@cloud.example'],
      subject: 'Your invoice for October is ready',
      body: 'Your invoice for October (USD 412.60) is ready. It will be charged to the card on file on the 25th. Nothing to do.',
      sent: at(-1, 9, 30),
    },
    {
      from: ['The Weekly Dev', 'news@weeklydev.example'],
      subject: 'This week: faster CI, smaller containers',
      body: 'Ten links on faster CI pipelines and smaller containers. Unsubscribe any time.',
      sent: at(0, 5, 0),
    },
  ];
  const zh: Mail[] = [
    {
      from: ['林佳慧', 'jiahui@northwind.example'],
      subject: `${weekday(2)}的設計審查可以改時間嗎？`,
      body: `Alex 你好：\n\n我們這邊臨時有事，${weekday(2)}的設計審查可以改到當天晚一點，或隔天早上嗎？15:00 以後我們都可以。\n\n謝謝\n佳慧\n北風設計`,
      sent: at(-1, 17, 42),
    },
    {
      from: ['陳志明', 'sam@example.com'],
      subject: '董事會簡報要用的 Q3 數字，今天中午前可以嗎？',
      body: 'Alex，\n\n今天中午前可以給我 Q3 的營收和流失率嗎？我下午要整理董事會簡報，粗略的數字就可以。\n\n志明',
      sent: at(0, 7, 58),
    },
    {
      from: ['CI', 'ci@example.com'],
      subject: '[budget-app] main 建置失敗：3 個測試沒過',
      body: 'main 在 06:12 建置失敗。\n\ncommit 4e1c9a2（"Import bank files a line at a time"）之後，test/import.test.js 有 3 個測試沒過。\n\nhttps://ci.example.com/budget-app/builds/2291',
      sent: at(0, 6, 14),
    },
    {
      from: ['王雅婷', 'lena@example.com'],
      subject: '團隊外訓規劃：下週約 30 分鐘？',
      body: 'Alex 你好：\n\n下週可以約 30 分鐘討論團隊外訓嗎？我早上比較方便，週三除外。\n\n雅婷',
      sent: at(-1, 19, 5),
    },
    {
      from: ['雲端帳務', 'billing@cloud.example'],
      subject: '你的 10 月帳單已出帳',
      body: '你的 10 月帳單（USD 412.60）已出帳，將於 25 日從你登記的信用卡扣款。不需要做任何事。',
      sent: at(-1, 9, 30),
    },
    {
      from: ['每週開發者電子報', 'news@weeklydev.example'],
      subject: '本週：更快的 CI、更小的容器',
      body: '十篇關於加快 CI 和縮小容器的文章。隨時可以取消訂閱。',
      sent: at(0, 5, 0),
    },
  ];
  return (lang === 'en' ? en : zh).map((m, i) => raw(i + 1, m));
}

/** iCalendar time in UTC. */
const ics = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function event(uid: string, summary: string, start: Date, minutes: number): string {
  const end = new Date(start.getTime() + minutes * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//harness-relay demo//EN',
    'BEGIN:VEVENT',
    `UID:${uid}@example.com`,
    `DTSTAMP:${ics(new Date())}`,
    `DTSTART:${ics(start)}`,
    `DTEND:${ics(end)}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Today's and the next days' calendar. */
export function calendar(lang: DemoLang): string[] {
  const L =
    lang === 'en'
      ? [
          'Team standup',
          'Focus: roadmap draft',
          '1:1 with Sam',
          'Dentist',
          'Design review with Northwind',
          'Sprint planning',
          'Customer call: Contoso',
        ]
      : ['團隊站會', '專注時間：路線圖草稿', '和志明一對一', '看牙醫', '與北風設計的設計審查', '衝刺規劃', '客戶通話：Contoso'];
  return [
    event('standup', L[0]!, at(0, 9, 30), 15),
    event('focus', L[1]!, at(0, 10, 0), 120),
    event('one-on-one', L[2]!, at(0, 14, 0), 30),
    event('dentist', L[3]!, at(0, 17, 30), 60),
    event('design-review', L[4]!, at(2, 10, 0), 60),
    event('planning', L[5]!, at(1, 9, 30), 90),
    event('contoso', L[6]!, at(2, 15, 30), 30),
  ];
}
