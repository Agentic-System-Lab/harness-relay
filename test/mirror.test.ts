import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as mirror from '../mirror/worker.ts';
import worker, {
  countOnGitHub,
  dayOf,
  githubUrl,
  handle,
  installerOf,
  rangeOf,
  type CountDatabase,
  type CountStatement,
  type Fetcher,
  type MirrorBucket,
} from '../mirror/worker.ts';
import { INSTALLERS, MIRROR, UPDATE_INSTALLERS, isMirror } from '../site/assets/downloads.js';

const TAG = '2026-11-13';
const MAC = `Harness-Relay-${TAG}-mac-arm64.dmg`;
const GITHUB = `https://github.com/Agentic-System-Lab/harness-relay/releases/download/${TAG}/${MAC}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const UPLOADED = new Date('2026-11-13T04:00:00Z');

/** A bucket holding `files`, as R2's binding answers, recording what it was asked. */
function bucket(files: Record<string, Uint8Array<ArrayBuffer>>, gone = new Set<string>()) {
  const asked: string[] = [];
  const meta = (key: string) => ({ size: files[key]!.length, httpEtag: `"etag-${key.length}"`, uploaded: UPLOADED });
  const b: MirrorBucket = {
    head: async (key) => (asked.push(`head ${key}`), key in files ? meta(key) : null),
    get: async (key, options) => {
      asked.push(`get ${key}${options?.range ? ` ${options.range.offset}+${options.range.length}` : ''}`);
      // Removed between the HEAD and the GET.
      if (!(key in files) || gone.has(key)) return null;
      const data = files[key]!;
      const part = options?.range ? data.slice(options.range.offset, options.range.offset + options.range.length) : data;
      return { ...meta(key), body: new Response(part).body! };
    },
  };
  return { b, asked };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

/** The Worker's codespaces count: where a codespace says it was made, its table, and one more for a day. */
const CODESPACES_PATH = '/codespaces';
const COUNT_TABLE = 'CREATE TABLE IF NOT EXISTS codespaces (day TEXT PRIMARY KEY, created INTEGER NOT NULL)';
const COUNT_ONE = 'INSERT INTO codespaces (day, created) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET created = created + 1';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Statement = CountStatement & { sql: string; values: string[] };

/**
 * The count's database as D1's binding answers, on SQLite as D1 is (a batch in one transaction), noting
 * each batch's statements; failing every batch with `fails`.
 */
function counts(fails = false) {
  const db = new DatabaseSync(':memory:');
  const batches: { sql: string; values: string[] }[][] = [];
  const statement = (sql: string, values: string[] = []): Statement => ({ sql, values, bind: (...v: string[]) => statement(sql, v) });
  const d: CountDatabase = {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const list = statements as Statement[];
      batches.push(list.map(({ sql, values }) => ({ sql, values })));
      if (fails) throw new Error('D1 is down');
      db.exec('BEGIN');
      try {
        for (const { sql, values } of list) db.prepare(sql).run(...values);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return [];
    },
  };
  /** The count's table as it is: each day's codespaces. */
  const rows = () => {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codespaces'").get();
    return exists ? db.prepare('SELECT day, created FROM codespaces ORDER BY day').all().map((r) => ({ ...r })) : [];
  };
  return { d, batches, rows };
}

/** The Worker asked for `path`, with GitHub's counting requests recorded and awaited. */
async function ask(path: string, init: RequestInit & { files?: Record<string, Uint8Array<ArrayBuffer>>; gone?: Set<string>; github?: Fetcher } = {}) {
  const { b, asked } = bucket(init.files ?? { [`${TAG}/${MAC}`]: bytes(1000) }, init.gone);
  const counted: { url: string; init: RequestInit }[] = [];
  const later: Promise<unknown>[] = [];
  const github: Fetcher =
    init.github ??
    (async (url, i) => {
      counted.push({ url, init: i });
      return new Response('x', { status: 206 });
    });
  const res = await handle(new Request(`https://mirror.example${path}`, init), { BUCKET: b, COUNTS: counts().d }, { waitUntil: (p) => void later.push(p) }, github);
  await Promise.all(later);
  return { res, counted, asked, body: res.body ? new Uint8Array(await res.arrayBuffer()) : null };
}

describe('the download mirror', () => {
  it('serves only the installers of a release, by the names the Release workflow gives them, and under their copies’ names for the app’s updates', () => {
    for (const [system, end] of Object.entries(INSTALLERS)) {
      const installer = `Harness-Relay-${TAG}${end}`;
      expect(installerOf(`/${TAG}/${installer}`), end).toEqual({ tag: TAG, file: installer, key: `${TAG}/${installer}`, update: false });
      // The copy's name is the same file in the bucket.
      const copy = `Harness-Relay-${TAG}${UPDATE_INSTALLERS[system as keyof typeof UPDATE_INSTALLERS]}`;
      expect(installerOf(`/${TAG}/${copy}`), copy).toEqual({ tag: TAG, file: copy, key: `${TAG}/${installer}`, update: true });
    }
    expect(installerOf('/2026-11-13.1/Harness-Relay-2026-11-13.1-win-arm64.exe')).toMatchObject({ tag: '2026-11-13.1', file: 'Harness-Relay-2026-11-13.1-win-arm64.exe' });
    for (const path of [
      // Another release's installer, or none of the five.
      `/${TAG}/Harness-Relay-2026-11-12-mac-arm64.dmg`,
      `/${TAG}/notes.txt`,
      `/${TAG}/Harness-Relay-${TAG}-mac-universal.dmg`,
      // Another release's copy.
      `/${TAG}/Harness-Relay-2026-11-12-mac-arm64-update.dmg`,
      // Paths that would leave the release's folder in the bucket.
      `/../${MAC}`,
      `/${TAG}/../${MAC}`,
      `/${TAG}/%2e%2e/${MAC}`,
      `/${TAG}/sub/${MAC}`,
      `/${TAG}/${MAC}/`,
      `/${MAC}`,
      '/',
      '',
    ]) {
      expect(installerOf(path), path).toBeUndefined();
    }
    expect(githubUrl({ tag: TAG, file: MAC })).toBe(GITHUB);
  });

  it('reads one byte range, and answers anything else with the whole file', () => {
    expect(rangeOf(null, 100)).toBe('whole');
    expect(rangeOf('bytes=0-9', 100)).toEqual({ offset: 0, length: 10 });
    expect(rangeOf(' bytes=10- ', 100)).toEqual({ offset: 10, length: 90 });
    expect(rangeOf('bytes=-1', 100)).toEqual({ offset: 99, length: 1 });
    expect(rangeOf('bytes=-500', 100)).toEqual({ offset: 0, length: 100 });
    expect(rangeOf('bytes=90-500', 100)).toEqual({ offset: 90, length: 10 });
    for (const header of ['bytes=0-9,20-29', 'bytes=9-0', 'items=0-9', 'bytes=-', 'bytes=a-b', '']) expect(rangeOf(header, 100), header).toBe('whole');
    expect(rangeOf('bytes=100-', 100)).toBe('unsatisfiable');
    expect(rangeOf('bytes=-0', 100)).toBe('unsatisfiable');
  });

  it('serves a download from its bucket, as a download to save, and has GitHub count it', async () => {
    const { res, body, counted, asked } = await ask(`/${TAG}/${MAC}`, { headers: { 'User-Agent': UA } });
    expect(res.status).toBe(200);
    expect(body).toEqual(bytes(1000));
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="${MAC}"`);
    expect(res.headers.get('ETag')).toBe(`"etag-${`${TAG}/${MAC}`.length}"`);
    expect(res.headers.get('Last-Modified')).toBe(UPLOADED.toUTCString());
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    // The website asks whether the mirror has it.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(asked).toEqual([`head ${TAG}/${MAC}`, `get ${TAG}/${MAC}`]);
    // Counted on GitHub as a download there is: its first byte, the redirect to GitHub's CDN followed,
    // with the visitor's user agent, never from a cache.
    expect(counted).toEqual([{ url: GITHUB, init: { headers: { Range: 'bytes=0-0', 'User-Agent': UA }, redirect: 'follow', cache: 'no-store' } }]);
  });

  it('counts a download in parts once, by its part from the first byte', async () => {
    const first = await ask(`/${TAG}/${MAC}`, { headers: { Range: 'bytes=0-99' } });
    expect(first.res.status).toBe(206);
    expect(first.res.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect(first.body).toEqual(bytes(1000).slice(0, 100));
    expect(first.asked).toContain(`get ${TAG}/${MAC} 0+100`);
    expect(first.counted).toHaveLength(1);
    // A resumed download, or a later part, is the same download.
    const later = await ask(`/${TAG}/${MAC}`, { headers: { Range: 'bytes=100-' } });
    expect(later.res.status).toBe(206);
    expect(later.res.headers.get('Content-Range')).toBe('bytes 100-999/1000');
    expect(later.body).toEqual(bytes(1000).slice(100));
    expect(later.counted).toEqual([]);
    // The Release workflow's check asks for the last byte: never counted.
    const last = await ask(`/${TAG}/${MAC}`, { headers: { Range: 'bytes=-1' } });
    expect(last.res.headers.get('Content-Range')).toBe('bytes 999-999/1000');
    expect(last.counted).toEqual([]);
  });

  it('sends the whole file to a resumed download whose file changed since (If-Range), and counts it', async () => {
    const changed = await ask(`/${TAG}/${MAC}`, { headers: { Range: 'bytes=500-', 'If-Range': '"another"' } });
    expect(changed.res.status).toBe(200);
    expect(changed.body).toHaveLength(1000);
    expect(changed.counted).toHaveLength(1);
    const etag = `"etag-${`${TAG}/${MAC}`.length}"`;
    const same = await ask(`/${TAG}/${MAC}`, { headers: { Range: 'bytes=500-', 'If-Range': etag } });
    expect(same.res.status).toBe(206);
    expect(same.counted).toEqual([]);
    const byDate = await ask(`/${TAG}/${MAC}`, { headers: { Range: 'bytes=500-', 'If-Range': UPLOADED.toUTCString() } });
    expect(byDate.res.status).toBe(206);
  });

  it('answers a range past the end as unsatisfiable, uncounted', async () => {
    const { res, counted } = await ask(`/${TAG}/${MAC}`, { headers: { Range: 'bytes=1000-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */1000');
    expect(counted).toEqual([]);
  });

  it('answers a HEAD (the website asks whether it has an installer) from the bucket, uncounted', async () => {
    const { res, body, counted, asked } = await ask(`/${TAG}/${MAC}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('1000');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(body).toBeNull();
    expect(asked).toEqual([`head ${TAG}/${MAC}`]);
    expect(counted).toEqual([]);
  });

  it("tells a browser its copy is current, uncounted", async () => {
    const etag = `"etag-${`${TAG}/${MAC}`.length}"`;
    for (const tag of [etag, `W/${etag}`, `"x", ${etag}`, '*']) {
      const { res, counted } = await ask(`/${TAG}/${MAC}`, { headers: { 'If-None-Match': tag } });
      expect(res.status, tag).toBe(304);
      expect(counted).toEqual([]);
    }
    expect((await ask(`/${TAG}/${MAC}`, { headers: { 'If-None-Match': '"x"' } })).res.status).toBe(200);
  });

  it('sends an installer its bucket does not have to GitHub, which counts it itself', async () => {
    for (const method of ['GET', 'HEAD']) {
      const { res, counted } = await ask(`/${TAG}/${MAC}`, { method, files: {} });
      expect(res.status, method).toBe(302);
      expect(res.headers.get('Location')).toBe(GITHUB);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(counted).toEqual([]);
    }
    // Also when the bucket fails (an R2 outage while the Worker runs), for the website's HEAD too.
    for (const fails of ['head', 'get'] as const) {
      for (const method of ['GET', 'HEAD']) {
        const { b } = bucket({ [`${TAG}/${MAC}`]: bytes(1000) });
        b[fails] = async () => Promise.reject(new Error('R2 is down'));
        const counted: string[] = [];
        const res = await handle(new Request(`https://mirror.example/${TAG}/${MAC}`, { method }), { BUCKET: b, COUNTS: counts().d }, { waitUntil: () => {} }, async (url) => (counted.push(url), new Response()));
        if (fails === 'get' && method === 'HEAD') {
          expect(res.status).toBe(200);
          continue;
        }
        expect(res.status, `${fails} ${method}`).toBe(302);
        expect(res.headers.get('Location')).toBe(GITHUB);
        expect(counted).toEqual([]);
      }
    }
    // Also when it was removed between the bucket's two answers (a release pruned).
    const gone = await ask(`/${TAG}/${MAC}`, { gone: new Set([`${TAG}/${MAC}`]) });
    expect(gone.res.status).toBe(302);
    expect(gone.res.headers.get('Location')).toBe(GITHUB);
    expect(gone.counted).toEqual([]);
  });

  it('serves nothing else, and takes nothing', async () => {
    for (const path of ['/', `/${TAG}/notes.txt`, `/${TAG}/Harness-Relay-2026-11-12-mac-arm64-update.dmg`, `/${TAG}/sub/${MAC}`]) {
      const { res, asked, counted } = await ask(path);
      expect(res.status, path).toBe(404);
      expect(asked).toEqual([]);
      expect(counted).toEqual([]);
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const { res, asked } = await ask(`/${TAG}/${MAC}`, { method, body: method === 'DELETE' ? undefined : 'x' });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD');
      expect(asked).toEqual([]);
    }
  });

  it("serves an app's update under its copy's name from the installer's file, never counted, and says so when it cannot (the app then goes to GitHub)", async () => {
    const COPY = `Harness-Relay-${TAG}-mac-arm64-update.dmg`;
    const whole = await ask(`/${TAG}/${COPY}`, { headers: { 'User-Agent': UA } });
    expect(whole.res.status).toBe(200);
    expect(whole.body).toEqual(bytes(1000));
    expect(whole.res.headers.get('Content-Disposition')).toBe(`attachment; filename="${COPY}"`);
    expect(whole.asked).toEqual([`head ${TAG}/${MAC}`, `get ${TAG}/${MAC}`]);
    // The app counts its update on GitHub itself, against the copy: never here, from the first byte either.
    expect(whole.counted).toEqual([]);
    const first = await ask(`/${TAG}/${COPY}`, { headers: { Range: 'bytes=0-99' } });
    expect(first.res.status).toBe(206);
    expect(first.res.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect(first.counted).toEqual([]);
    expect((await ask(`/${TAG}/${COPY}`, { method: 'HEAD' })).res.status).toBe(200);
    // Not in the bucket (a release candidate, an older release), or the bucket failing: no redirect to
    // the installer, which GitHub would count as a new install. The app downloads the copy from GitHub.
    for (const method of ['GET', 'HEAD']) {
      const missing = await ask(`/${TAG}/${COPY}`, { method, files: {} });
      expect(missing.res.status, method).toBe(404);
      expect(missing.res.headers.get('Location')).toBeNull();
      expect(missing.counted).toEqual([]);
    }
    const gone = await ask(`/${TAG}/${COPY}`, { gone: new Set([`${TAG}/${MAC}`]) });
    expect(gone.res.status).toBe(404);
    for (const fails of ['head', 'get'] as const) {
      const { b } = bucket({ [`${TAG}/${MAC}`]: bytes(1000) });
      b[fails] = async () => Promise.reject(new Error('R2 is down'));
      const res = await handle(new Request(`https://mirror.example/${TAG}/${COPY}`), { BUCKET: b, COUNTS: counts().d }, { waitUntil: () => {} }, async () => new Response());
      expect(res.status, fails).toBe(503);
      expect(res.headers.get('Location')).toBeNull();
    }
  });

  it('serves the download when GitHub cannot be reached to count it', async () => {
    const { res, body } = await ask(`/${TAG}/${MAC}`, { github: async () => Promise.reject(new Error('offline')) });
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1000);
    // GitHub's answer is not read: only its first byte is asked for, and its body let go.
    let cancelled = false;
    const stream = new ReadableStream({ cancel: () => void (cancelled = true) });
    await countOnGitHub(GITHUB, null, async (_url, init) => {
      expect(init.headers).toEqual({ Range: 'bytes=0-0' });
      return new Response(stream, { status: 206 });
    });
    expect(cancelled).toBe(true);
  });

  it('is deployed with its bucket, the one the Release workflow uploads to, and the count\'s database, which wrangler makes', () => {
    expect(typeof worker.fetch).toBe('function');
    // The Workers runtime takes every export for an entry point, and starts only when each is a function
    // or a handler (a string among them stops it).
    for (const [name, value] of Object.entries(mirror)) if (name !== 'default') expect(typeof value, name).toBe('function');
    expect(mirror.default).toBe(worker);
    const config = readFileSync('mirror/wrangler.toml', 'utf8');
    expect(config).toMatch(/^main = "worker\.ts"$/m);
    expect(config).toMatch(/^\[\[r2_buckets\]\]\nbinding = "BUCKET"\nbucket_name = "harness-relay-mirror"$/m);
    // By its name alone: `wrangler deploy` makes it the first time, and finds it after.
    expect(config).toMatch(/^\[\[d1_databases\]\]\nbinding = "COUNTS"\ndatabase_name = "harness-relay-counts"$/m);
    expect(config).not.toMatch(/^database_id\s*=/m);
    // The command its comment gives reads the table the Worker writes.
    expect(config).toContain('npx wrangler d1 execute harness-relay-counts --remote --config mirror/wrangler.toml --command "SELECT day, created FROM codespaces ORDER BY day"');
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(workflow).toMatch(/^ {2}MIRROR_BUCKET: harness-relay-mirror$/m);
    // The website's mirror is none, or an https origin the workflow can upload to.
    expect(MIRROR === '' || isMirror(MIRROR)).toBe(true);
  });
});

describe("the download mirror's codespaces count", () => {
  /** The Worker asked at `path` with the count's database `c`, at `now`; the bucket and GitHub noted. */
  async function count(c: ReturnType<typeof counts>, init: RequestInit = { method: 'POST' }, now = new Date('2026-11-14T03:00:00Z'), path = CODESPACES_PATH) {
    const { b, asked } = bucket({});
    const counted: string[] = [];
    const res = await handle(new Request(`https://mirror.example${path}`, init), { BUCKET: b, COUNTS: c.d }, { waitUntil: () => {} }, async (url) => (counted.push(url), new Response()), now);
    return { res, asked, counted };
  }

  it("adds a codespace to its day's count, and keeps nothing else", async () => {
    const c = counts();
    const { res, asked, counted } = await count(c, { method: 'POST', headers: { 'User-Agent': 'curl/8.5.0', 'CF-Connecting-IP': '20.1.2.3' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('');
    // The table made by the first count, in the same batch: a new database is empty.
    expect(c.batches).toEqual([[{ sql: COUNT_TABLE, values: [] }, { sql: COUNT_ONE, values: ['2026-11-14'] }]]);
    expect(c.rows()).toEqual([{ day: '2026-11-14', created: 1 }]);
    // Neither the bucket nor GitHub.
    expect(asked).toEqual([]);
    expect(counted).toEqual([]);
    // Its user agent and address are kept nowhere: the table has the day and the count only.
    expect(Object.keys(c.rows()[0]!)).toEqual(['day', 'created']);
  });

  it("counts each day apart, by Taiwan's day, as releases go", async () => {
    const c = counts();
    await count(c);
    await count(c, { method: 'POST', body: 'anything' });
    // 15:59 UTC is 23:59 in Taiwan; 16:00 UTC the next day there.
    await count(c, { method: 'POST' }, new Date('2026-11-14T15:59:59Z'));
    await count(c, { method: 'POST' }, new Date('2026-11-14T16:00:00Z'));
    expect(c.rows()).toEqual([
      { day: '2026-11-14', created: 3 },
      { day: '2026-11-15', created: 1 },
    ]);
    expect(dayOf(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01');
    expect(dayOf(new Date('2026-03-01T15:59:59Z'))).toBe('2026-03-01');
  });

  it('takes a POST only, at that path only', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const c = counts();
      const { res } = await count(c, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('Allow'), method).toBe('POST');
      expect(c.batches, method).toEqual([]);
    }
    // Any other path is the installers' (a POST there is refused, a GET is not found).
    for (const path of ['/codespaces/', '/codespaces/1', '/Codespaces', `/${TAG}/codespaces`]) {
      const c = counts();
      const { res } = await count(c, { method: 'POST' }, undefined, path);
      expect(res.status, path).toBe(405);
      expect(res.headers.get('Allow'), path).toBe('GET, HEAD');
      expect(c.batches, path).toEqual([]);
    }
    // A query string does not change the path.
    const c = counts();
    expect((await count(c, { method: 'POST' }, undefined, `${CODESPACES_PATH}?v=1`)).res.status).toBe(204);
    expect(c.rows()).toEqual([{ day: '2026-11-14', created: 1 }]);
  });

  it("refuses a browser's request, which names its page: a web page cannot have its visitors count", async () => {
    for (const origin of ['https://example.com', 'null', 'https://agentic-system-lab.github.io']) {
      const c = counts();
      const { res } = await count(c, { method: 'POST', headers: { Origin: origin } });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
      expect(c.batches, origin).toEqual([]);
    }
  });

  it('says so when the database fails, and the codespace goes uncounted', async () => {
    const c = counts(true);
    const { res } = await count(c);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(c.batches).toHaveLength(1);
  });
});
