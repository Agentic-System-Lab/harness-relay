import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PAGE_FILES, SITE_PAGES } from './site-pages';
import { slow } from './timeouts';
import { jobsIn, pagesStep, pagesWorkflow, stepsOf } from './workflow-steps';

// IndexNow (docs/developer-guide.md, "Website" → "Search engines"): after each deployment the Pages workflow tells
// it which pages the deployment added, changed or removed, with the key the site serves, and only warns when it
// cannot.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = pagesWorkflow();
const SITE = /^ {2}SITE: (\S+)$/m.exec(workflow)?.[1];
const KEY = /^ {2}INDEXNOW_KEY: (\S+)$/m.exec(workflow)?.[1];
const FIND = 'Find the pages the deployment changes';
const TELL = 'Tell IndexNow which pages changed';
const PAGES = PAGE_FILES;
const EN = 'https://agentic-system-lab.github.io/harness-relay/';
const ZH = 'https://agentic-system-lab.github.io/harness-relay/zh-TW/';
/** Every page of the sitemap, in its order. */
const ALL = SITE_PAGES.map((p) => p.url);
/** The Chinese pages, all under zh-TW/, in the sitemap's order. */
const ZH_ALL = ALL.filter((url) => url.startsWith(ZH));

describe("IndexNow's key", () => {
  it('is one the protocol takes, and the site serves it as it is, at the top of the site', () => {
    expect(KEY).toMatch(/^[A-Za-z0-9-]{8,128}$/);
    expect(read(`site/${KEY}.txt`)).toBe(KEY);
  });

  it('is good for every page: they are all under the site, where the key file is', () => {
    expect(SITE).toBe(EN);
    const locs = [...read('site/sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(ALL);
    for (const page of PAGES) expect(read(page), page).toMatch(new RegExp(`<link rel="canonical" href="${SITE}[^"]*" />`));
  });

  it('is published with the pages: the Pages workflow copies site/ and deletes no .txt file', () => {
    expect(workflow).toMatch(/cp -R site\/\. _site\//);
    const deletes = workflow.split('\n').filter((line) => /\bfind _site\b/.test(line) && /-delete\b/.test(line));
    expect(deletes).toHaveLength(1);
    const patterns = [...deletes[0].matchAll(/-name '([^']+)'/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThan(0);
    const glob = (p: string) =>
      new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replaceAll('*', '.*')
          .replaceAll('?', '.')}$`,
      );
    for (const pattern of patterns) expect(glob(pattern).test(`${KEY}.txt`), pattern).toBe(false);
  });
});

describe("the Pages workflow's IndexNow steps", () => {
  it('run in bash with -o pipefail, as the tests run them: the default shell, which no step changes', () => {
    expect(workflow).toContain('\ndefaults:\n  run:\n    shell: bash\n');
    expect(workflow.split('\n').filter((line) => /^\s*shell:/.test(line))).toEqual(['    shell: bash']);
  });

  it('find the changed pages before the deployment replaces them, and tell IndexNow once it is out', () => {
    const at = (text: string) => {
      const i = workflow.indexOf(text);
      expect(i, text).toBeGreaterThan(0);
      return i;
    };
    expect(at(`- name: ${FIND}\n`)).toBeGreaterThan(at('- name: Assemble the site\n'));
    expect(at(`- name: ${FIND}\n`)).toBeLessThan(at('uses: actions/upload-pages-artifact@'));
    expect(at(`- name: ${TELL}\n`)).toBeGreaterThan(at('uses: actions/deploy-pages@'));
    // The last step, and one without a condition: it runs only when the deployment did.
    const tell = workflow.slice(at(`- name: ${TELL}\n`));
    expect(tell.indexOf('\n      - ')).toBe(-1);
    expect(tell).not.toMatch(/\n {8}if:/);
  });

  it('hand the changed pages from the build job to the deploy job, through an output and the environment', () => {
    const jobs = jobsIn(workflow);
    const build = jobs.get('build')!;
    const deploy = jobs.get('deploy')!;
    const find = stepsOf(build).find((s) => s.startsWith(`name: ${FIND}\n`));
    expect(find).toMatch(/^name: .+\n {8}id: changed\n {8}run: \|\n/);
    expect(build).toContain('\n    outputs:\n');
    expect(build).toMatch(/\n {6}changed: \$\{\{ steps\.changed\.outputs\.pages \}\}\n/);
    expect(deploy).toContain('\n    needs: build\n');
    const tell = stepsOf(deploy).find((s) => s.startsWith(`name: ${TELL}\n`));
    // In the environment, never in the script's text, where the runner would put it as it is.
    expect(tell).toMatch(/^name: .+\n {8}env:\n {10}CHANGED_PAGES: \$\{\{ needs\.build\.outputs\.changed \}\}\n {8}run: \|\n/);
    expect(pagesStep(TELL)).not.toContain('${{');
  });
});

/** A step's outputs, read as the runner reads `$GITHUB_OUTPUT`: `name=value` lines and `name<<delimiter` blocks. */
function outputsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    const heredoc = line.indexOf('<<');
    const equals = line.indexOf('=');
    if (heredoc >= 0 && (equals < 0 || heredoc < equals)) {
      const delimiter = line.slice(heredoc + 2);
      const end = lines.indexOf(delimiter, i + 1);
      if (end < 0) throw new Error(`no end to the output ${line.slice(0, heredoc)}`);
      out[line.slice(0, heredoc)] = lines.slice(i + 1, end).join('\n');
      i = end;
    } else {
      out[line.slice(0, equals)] = line.slice(equals + 1);
    }
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'relay-indexnow-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A stand-in for `curl`, noting its arguments in `CURL_CALLS`. A page or the sitemap is read from `LIVE`, the site
 * as it is live, failing as `curl -f` does when it is not there (404) or when `CURL_DOWN` is set (no answer). A
 * POST notes its body in `CURL_BODY` and answers `CURL_CODE` (its `-w '%{http_code}'`), or none when that is 000.
 */
const bin = join(tmp, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'curl'),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$CURL_CALLS"
out=''; data=''; url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    --data-binary) data=\${2#@}; shift ;;
    -w|-H|-X|--max-time) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
if [ -n "$data" ]; then
  cp "$data" "$CURL_BODY"
  if [ "$CURL_CODE" = 000 ]; then echo 'curl: (6) Could not resolve host: api.indexnow.org' >&2; printf 000; exit 6; fi
  printf '%s' "$CURL_CODE"; exit 0
fi
if [ -n "$CURL_DOWN" ]; then echo 'curl: (7) Failed to connect' >&2; exit 7; fi
path=\${url#"$SITE"}
case "$path" in ''|*/) path="\${path}index.html" ;; esac
if [ ! -f "$LIVE/$path" ]; then echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22; fi
cp "$LIVE/$path" "$out"
`,
);
chmodSync(join(bin, 'curl'), 0o755);

interface Run {
  status: number | null;
  out: string;
  calls: string[];
  summary: string;
  /** What the step wrote to `$GITHUB_OUTPUT`, as it is and as the runner reads it. */
  output: string;
  outputs: Record<string, string>;
  /** The changed pages the step handed on in its output. */
  changed: string[];
  body: unknown;
}

/**
 * One of the steps, run as the runner runs it, in a job folder with the site assembled (`_site`) and the stand-in.
 * `changed` is the build job's output the deploy job's step gets (`CHANGED_PAGES`): addresses, or the value as it is.
 */
function step(
  name: string,
  {
    live,
    changed,
    code = '200',
    down = false,
  }: { live?: (dir: string) => void; changed?: string[] | string; code?: string; down?: boolean } = {},
): Run {
  const run = mkdtempSync(join(tmp, 'run-'));
  const temp = join(run, 'runner-temp');
  mkdirSync(temp);
  cpSync(new URL('../site', import.meta.url), join(run, '_site'), { recursive: true });
  const liveDir = join(run, 'live');
  cpSync(new URL('../site', import.meta.url), liveDir, { recursive: true });
  live?.(liveDir);
  const calls = join(run, 'calls');
  const summary = join(run, 'summary.md');
  const output = join(run, 'output');
  const body = join(run, 'body.json');
  writeFileSync(calls, '');
  writeFileSync(summary, '');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', pagesStep(name)], {
    cwd: run,
    encoding: 'utf8',
    timeout: slow(20_000),
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
      SITE: SITE!,
      INDEXNOW_KEY: KEY!,
      LIVE: liveDir,
      CURL_CALLS: calls,
      CURL_BODY: body,
      CURL_CODE: code,
      ...(down ? { CURL_DOWN: '1' } : {}),
      ...(changed === undefined ? {} : { CHANGED_PAGES: typeof changed === 'string' ? changed : changed.join('\n') }),
    },
  });
  const written = readFileSync(output, 'utf8');
  const outputs = outputsOf(written);
  const result = {
    status: r.status,
    out: r.stdout + r.stderr,
    calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
    summary: readFileSync(summary, 'utf8'),
    output: written,
    outputs,
    changed: (outputs.pages ?? '').split('\n').filter(Boolean),
    body: existsSync(body) ? JSON.parse(readFileSync(body, 'utf8')) : undefined,
  };
  // Two copies of the site each (over 100 MB): gone once read, not all left to afterAll, whose time a
  // busy runner's disk overran (10 s) with every run's copies at once.
  rmSync(run, { recursive: true, force: true });
  return result;
}

const edit = (dir: string, path: string, change: (text: string) => string) =>
  writeFileSync(join(dir, path), change(readFileSync(join(dir, path), 'utf8')));

// The steps' scripts run in bash, which the Windows runners do not have as Linux's.
describe.skipIf(process.platform === 'win32')('finding the pages the deployment changes', { timeout: slow(20_000) }, () => {
  it('finds none when every page is the one live, reading each page and the live sitemap', () => {
    const r = step(FIND);
    expect(r.status, r.out).toBe(0);
    expect(r.outputs).toEqual({ pages: '' });
    expect(r.out).toBe('The deployment changes no page.\n');
    // Each read as a failure when the server answers one (-f), within its time.
    expect(r.calls.map((call) => call.split(' ').at(-1))).toEqual([...ALL, `${SITE}sitemap.xml`]);
    for (const call of r.calls) expect(call).toMatch(/^-fsS --max-time 30 -o \S+ \S+$/);
  });

  it('finds a page whose HTML is not the live one, and only it', () => {
    const r = step(FIND, { live: (dir) => edit(dir, 'zh-TW/index.html', (html) => html.replace('</body>', '<p>old</p></body>')) });
    expect(r.status, r.out).toBe(0);
    expect(r.outputs).toEqual({ pages: ZH });
    expect(r.out).toBe(`The deployment changes:\n${ZH}\n`);
  });

  it('hands on every changed page, one address to a line, under a delimiter of its own each run', () => {
    const delimiters = [step(FIND, { down: true }), step(FIND, { down: true })].map((r) => {
      expect(r.status, r.out).toBe(0);
      expect(r.outputs).toEqual({ pages: ALL.join('\n') });
      const delimiter = /^pages<<([0-9a-f]{32})\n/.exec(r.output)?.[1];
      expect(r.output).toBe(`pages<<${delimiter}\n${ALL.join('\n')}\n${delimiter}\n`);
      return delimiter;
    });
    expect(delimiters[0]).not.toBe(delimiters[1]);
  });

  it('finds a page the site does not have yet', () => {
    // The Chinese pages' folder, both of them.
    const r = step(FIND, { live: (dir) => rmSync(join(dir, 'zh-TW'), { recursive: true }) });
    expect(r.status, r.out).toBe(0);
    expect(r.changed).toEqual(ZH_ALL);
  });

  it('finds a page the live sitemap lists and the new one does not: a removed page', () => {
    const OLD = `${SITE}old/`;
    const r = step(FIND, {
      live: (dir) => edit(dir, 'sitemap.xml', (xml) => xml.replace('</urlset>', `  <url>\n    <loc>${OLD}</loc>\n  </url>\n</urlset>`)),
    });
    expect(r.status, r.out).toBe(0);
    expect(r.changed).toEqual([OLD]);
  });

  it('takes every page as changed when the live site cannot be read, and none as removed', () => {
    const r = step(FIND, { down: true });
    expect(r.status, r.out).toBe(0);
    expect(r.changed).toEqual(ALL);
  });
});

describe.skipIf(process.platform === 'win32')('telling IndexNow', { timeout: slow(20_000) }, () => {
  const POST = `-sS --max-time 30 -o /dev/null -w %{http_code} -X POST -H Content-Type: application/json; charset=utf-8 --data-binary @`;

  it('tells it nothing when no page changed (the build job handed on none, or only empty lines)', () => {
    for (const changed of [[], '\n', '\n\n']) {
      const r = step(TELL, { changed });
      expect(r.status, r.out).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.out).toBe('No page changed: IndexNow is not told.\n');
    }
  });

  it('sends the pages the build job found, as its output hands them on, and no empty line as a page', () => {
    const found = step(FIND, { live: (dir) => rmSync(join(dir, 'zh-TW'), { recursive: true }) });
    expect(found.status, found.out).toBe(0);
    const r = step(TELL, { changed: found.outputs.pages });
    expect(r.status, r.out).toBe(0);
    expect(r.body).toMatchObject({ urlList: ZH_ALL });
    const blank = step(TELL, { changed: `\n${EN}\n\n${ZH}\n` });
    expect(blank.body).toMatchObject({ urlList: [EN, ZH] });
    expect(blank.out).toBe('IndexNow was told of 2 changed page(s) (HTTP 200).\n');
  });

  it('sends the changed pages with the host, the key and where the site serves it, as the protocol has it', () => {
    const r = step(TELL, { changed: [EN, ZH] });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(
      new RegExp(`^${POST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\S+indexnow\\.json https://api\\.indexnow\\.org/indexnow$`),
    );
    expect(r.body).toEqual({ host: 'agentic-system-lab.github.io', key: KEY, keyLocation: `${SITE}${KEY}.txt`, urlList: [EN, ZH] });
    expect(r.out).toBe('IndexNow was told of 2 changed page(s) (HTTP 200).\n');
    expect(r.summary).toBe('');
  });

  it('takes 202, its answer while the key file is yet to be checked, as told', () => {
    const r = step(TELL, { changed: [ZH], code: '202' });
    expect(r.status, r.out).toBe(0);
    expect(r.body).toMatchObject({ urlList: [ZH] });
    expect(r.out).toBe('IndexNow was told of 1 changed page(s) (HTTP 202).\n');
  });

  it('only warns, in the log and the summary, when IndexNow refuses or does not answer', () => {
    for (const [code, why] of [
      ['400', 'HTTP 400: the request is not as the protocol has it'],
      ['403', `HTTP 403: the key is not the one ${SITE}${KEY}.txt serves`],
      ['422', `HTTP 422: a page is not under ${SITE}, or the key is not as the protocol has it`],
      ['429', 'HTTP 429: too many requests'],
      ['500', 'HTTP 500'],
      ['000', 'no answer: curl: (6) Could not resolve host: api.indexnow.org'],
    ] as const) {
      const r = step(TELL, { changed: [EN], code });
      expect(r.status, code).toBe(0);
      const message = `IndexNow was not told of the changed pages (${why}): the search engines find them when they next read the sitemap, which dates them.`;
      expect(r.out, code).toBe(`::warning::${message}\n`);
      expect(r.summary, code).toBe(`${message}\n`);
    }
  });
});
