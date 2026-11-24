/**
 * The READMEs' contributors (README.md and README.zh-TW.md, between `<!-- contributors:start -->` and
 * `<!-- contributors:end -->`): the people GitHub counts as this repository's contributors (their
 * commits), most commits first, without bots and the accounts `.github/contributors.json` leaves out,
 * then the people it adds, who helped in other ways. Each is their avatar and name, linking to their
 * profile.
 *
 * The Contributors workflow (.github/workflows/contributors.yml) runs it after each push to main and
 * every week, and puts what changed in a pull request. By hand, with your own `gh`:
 *   npx tsx scripts/contributors.ts           update the READMEs
 *   npx tsx scripts/contributors.ts --check   only say whether they are up to date (exit 1 when not)
 *
 * Only `node:` modules, so that the workflow runs it with Node itself, without npm ci.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const START = '<!-- contributors:start -->';
export const END = '<!-- contributors:end -->';
/** People in a row of the table. */
export const PER_ROW = 7;
export const READMES = ['README.md', 'README.zh-TW.md'];
const LIST = '.github/contributors.json';
const AVATAR_HOST = 'https://avatars.githubusercontent.com/';

/** The hand-kept part: people to add (help other than commits) and accounts to leave out. */
export interface ContributorList {
  add: string[];
  leaveOut: string[];
}

/** One of GitHub's contributors, as its API lists them. */
export interface ApiContributor {
  login: string;
  type: string;
  contributions: number;
}

export interface Person {
  login: string;
  /** Their name on GitHub, else their login. */
  name: string;
  avatar: string;
}

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function parseList(text: string): ContributorList {
  const value: unknown = JSON.parse(text);
  const logins = (key: string): string[] => {
    const list = (value as Record<string, unknown> | null)?.[key];
    if (list === undefined) return [];
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && LOGIN.test(x))) {
      throw new Error(`${LIST}: "${key}" must be a list of GitHub logins`);
    }
    return list as string[];
  };
  return { add: logins('add'), leaveOut: logins('leaveOut') };
}

/**
 * Who the READMEs list, in order: GitHub's contributors (as it orders them, most commits first)
 * that are people and not left out, then the people added, each once (logins compared without case).
 */
export function pickLogins(contributors: ApiContributor[], list: ContributorList): string[] {
  const seen = new Set(list.leaveOut.map((l) => l.toLowerCase()));
  const picked: string[] = [];
  const take = (login: string) => {
    if (seen.has(login.toLowerCase())) return;
    seen.add(login.toLowerCase());
    picked.push(login);
  };
  for (const c of contributors) if (c.type === 'User' && LOGIN.test(c.login)) take(c.login);
  for (const login of list.add) take(login);
  return picked;
}

/** Text for HTML, between tags or in a quoted attribute. */
export function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, (c) => entities[c]!);
}

/** The avatar at twice the size it is shown, for sharp screens; only GitHub's avatar host. */
export function avatarUrl(avatar: string): string {
  const url = new URL(avatar);
  if (!url.href.startsWith(AVATAR_HOST)) throw new Error(`not a GitHub avatar: ${avatar}`);
  url.searchParams.set('s', '128');
  return url.href;
}

/** The table the markers hold: avatars and names, PER_ROW to a row. */
export function renderTable(people: Person[]): string {
  const cell = (p: Person) =>
    `    <td align="center" valign="top" width="120"><a href="https://github.com/${encodeURIComponent(p.login)}">` +
    `<img src="${escapeHtml(avatarUrl(p.avatar))}" width="64" height="64" alt=""><br><sub><b>${escapeHtml(p.name)}</b></sub></a></td>`;
  const rows: string[] = [];
  for (let i = 0; i < people.length; i += PER_ROW) {
    rows.push(['  <tr>', ...people.slice(i, i + PER_ROW).map(cell), '  </tr>'].join('\n'));
  }
  return ['<table>', ...rows, '</table>'].join('\n');
}

/** The README with the markers' content replaced; it must have each marker once, in order. */
export function replaceSection(readme: string, table: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + 1) >= 0 || readme.indexOf(END, end + 1) >= 0) {
    throw new Error(`each README needs ${START} and ${END}, once each, in that order`);
  }
  return `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/** GitHub's contributors of the repository, every page of them. */
function contributorsOf(repo: string): ApiContributor[] {
  const lines = gh(['api', '--paginate', `repos/${repo}/contributors?per_page=100`, '--jq', '.[] | {login, type, contributions}']);
  return lines
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ApiContributor);
}

function personOf(login: string): Person {
  const user = JSON.parse(gh(['api', `users/${encodeURIComponent(login)}`])) as {
    login: string;
    name: string | null;
    avatar_url: string;
  };
  return { login: user.login, name: user.name?.trim() || user.login, avatar: user.avatar_url };
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const check = process.argv.includes('--check');
  const unknown = process.argv.slice(2).filter((a) => a !== '--check');
  if (unknown.length) throw new Error(`unknown option: ${unknown.join(' ')}`);
  const repo = process.env.GITHUB_REPOSITORY?.trim() || 'Agentic-System-Lab/harness-relay';
  const list = parseList(readFileSync(join(root, LIST), 'utf8'));
  const people = pickLogins(contributorsOf(repo), list).map(personOf);
  const table = renderTable(people);
  let stale = 0;
  for (const name of READMES) {
    const path = join(root, name);
    const before = readFileSync(path, 'utf8');
    const after = replaceSection(before, table);
    if (after === before) continue;
    stale++;
    if (!check) writeFileSync(path, after);
    console.log(`${name}: ${check ? 'out of date' : 'updated'}`);
  }
  console.log(`${people.length} contributors: ${people.map((p) => p.login).join(', ')}`);
  if (check && stale) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
