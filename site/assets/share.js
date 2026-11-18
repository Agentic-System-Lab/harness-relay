// Harness Relay's viewer of a shared conversation (site/share/): the page Share made, a secret gist on
// GitHub that the link names after its `#` (`#<owner>/<id>`, never sent to any server). It reads the
// gist's file from GitHub's raw files (gist.githubusercontent.com), not from GitHub's API, which lets
// a browser that is not signed in ask only 60 times an hour (gistpreview.github.io, which shared pages
// were read on before, reads the API): the API is asked only when the raw files have no such gist
// under that owner (renamed since), or the link names none. It shows only a page Harness Relay made
// (GENERATOR), in a frame that runs no script and has an origin of its own (`sandbox` without
// `allow-scripts` or `allow-same-origin`), so a gist can never run anything on this website. Its
// functions are tested in test/site-share.test.ts.

/** Where GitHub serves a gist's files as they are (as text, with CORS: any page may read them). */
export const RAW_HOST = 'https://gist.githubusercontent.com/';

/** GitHub's API, asked only when the raw files cannot say where the gist is (60 times an hour a browser). */
export const API_HOST = 'https://api.github.com/';

/** The page's file in its gist (`SHARE_FILE` in src/server/share.ts). */
export const SHARE_FILE = 'index.html';

/** What every page Harness Relay shares says made it (`<meta name="generator">`, shareDocument() in src/web/share.ts). */
export const GENERATOR = 'Harness Relay';

/** A GitHub account's name, as gist addresses have it. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A gist's id, as Harness Relay's shares have them (`validGistId` in src/server/share.ts). */
const GIST_ID = /^[0-9a-f]{20,}$/;

/** The gist a viewer address's fragment names: `#<owner>/<id>`, or `#<id>` (its owner then unknown), or undefined. */
export function gistOf(hash) {
  if (typeof hash !== 'string') return undefined;
  const parts = hash.replace(/^#/, '').replace(/\/$/, '').split('/');
  if (parts.length > 2) return undefined;
  let decoded;
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return undefined;
  }
  const [owner, id] = decoded.length === 2 ? decoded : [undefined, decoded[0]];
  if (!GIST_ID.test(id) || (owner !== undefined && !OWNER.test(owner))) return undefined;
  return owner === undefined ? { id } : { owner, id };
}

/** The gist's page file, as GitHub serves it raw (its newest version); the gist's owner must be known. */
export function rawUrl(gist) {
  return `${RAW_HOST}${encodeURIComponent(gist.owner)}/${encodeURIComponent(gist.id)}/raw/${SHARE_FILE}`;
}

/** Where GitHub's API describes the gist. */
export function apiUrl(id) {
  return `${API_HOST}gists/${encodeURIComponent(id)}`;
}

/**
 * The gist's owner and its page file's raw address, from GitHub's API answer about gist `id`: only an
 * address of that gist on RAW_HOST, under that owner. Undefined for anything else.
 */
export function pageFromApi(info, id) {
  if (!info || typeof info !== 'object' || info.id !== id) return undefined;
  const owner = info.owner?.login;
  const raw = info.files?.[SHARE_FILE]?.raw_url;
  if (typeof owner !== 'string' || !OWNER.test(owner) || typeof raw !== 'string') return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const [rawOwner, rawId] = url.pathname.split('/').slice(1, 3);
  if (`${url.origin}/` !== RAW_HOST || rawOwner?.toLowerCase() !== owner.toLowerCase() || rawId !== id) return undefined;
  return { owner, raw: url.href };
}

/** The gist's own page on GitHub. */
export function gistPage(gist) {
  const owner = gist.owner === undefined ? '' : `${encodeURIComponent(gist.owner)}/`;
  return `https://gist.github.com/${owner}${encodeURIComponent(gist.id)}`;
}

/** The viewer's language for a language tag: Traditional Chinese for any Chinese, else English. */
export function langOf(tag) {
  return typeof tag === 'string' && /^zh(?:-|$)/i.test(tag.trim()) ? 'zh-TW' : 'en';
}

/** Whether a page is one Harness Relay shared, by what its `<meta name="generator">` says. */
export function isSharedPage(generator) {
  return generator === GENERATOR;
}

/** What the viewer says, in its two languages. */
export const WORDS = {
  en: {
    title: 'Shared conversation · Harness Relay',
    loading: 'Loading the shared conversation…',
    sharedBy: (owner) => ['Shared by ', `@${owner}`, ' as a GitHub gist'],
    viewGist: 'View on GitHub',
    invalid: 'This address does not name a shared conversation. Check that the link was copied whole.',
    notFound: 'This shared conversation is not on GitHub: it was removed, or the link was not copied whole.',
    notShared: 'This gist is not a conversation shared from Harness Relay, so it is not shown here.',
    failed: (detail) => `Could not load the shared conversation from GitHub (${detail}). Try again in a moment.`,
    offline: 'no connection',
    home: "Harness Relay's website",
    homeHref: '../',
  },
  'zh-TW': {
    title: '分享的對話 · Harness Relay',
    loading: '正在載入分享的對話…',
    sharedBy: (owner) => ['由 ', `@${owner}`, ' 以 GitHub gist 分享'],
    viewGist: '在 GitHub 上查看',
    invalid: '這個網址沒有指向分享的對話。請確認連結有完整複製。',
    notFound: 'GitHub 上沒有這個分享的對話：它已被移除，或連結沒有完整複製。',
    notShared: '這個 gist 不是從 Harness Relay 分享的對話，所以不在這裡顯示。',
    failed: (detail) => `無法從 GitHub 載入分享的對話（${detail}）。請稍後再試。`,
    offline: '沒有網路連線',
    home: 'Harness Relay 網站',
    homeHref: '../zh-TW/',
  },
};

/**
 * How the frame takes a link. One within the page (`#…`, a review point's @name) would resolve against
 * this viewer's address in a srcdoc frame, and open the viewer in it: pointed at the frame's own
 * document instead, it scrolls there, and its words match `:target`. Every other link opens in a tab
 * of its own, which never learns what opened it (`noopener`: else, in Firefox, a page it opens could
 * move this tab elsewhere) nor gets a referrer.
 */
export function linkPlan(href) {
  if (typeof href !== 'string') return undefined;
  if (href.startsWith('#')) return { href: `about:srcdoc${href}` };
  return { href, target: '_blank', rel: 'noopener noreferrer' };
}

/** What went wrong reading the gist, from its answer: none (`ok`), not there, or another failure. */
export function failureOf(status) {
  if (status >= 200 && status < 300) return undefined;
  return status === 404 ? { kind: 'notFound' } : { kind: 'failed', detail: `HTTP ${status}` };
}

// --- The page ---------------------------------------------------------------------------

/** The viewer's own elements (site/share/index.html). */
function parts(doc) {
  return {
    bar: doc.getElementById('share-bar'),
    by: doc.getElementById('share-by'),
    gist: doc.getElementById('share-gist'),
    status: doc.getElementById('share-status'),
    message: doc.getElementById('share-message'),
    home: doc.getElementById('share-home'),
    frame: doc.getElementById('share-frame'),
  };
}

/** The bar's words: who shared it (when that is known), and the gist's page on GitHub. */
function fillBar(el, words, gist) {
  if (gist.owner === undefined) {
    el.by.replaceChildren();
  } else {
    const [before, owner, after] = words.sharedBy(gist.owner);
    const name = document.createElement('b');
    name.textContent = owner;
    el.by.replaceChildren(before, name, after);
  }
  el.gist.textContent = words.viewGist;
  el.gist.href = gistPage(gist);
  el.bar.hidden = false;
}

/** A message in place of the page (loading, or what went wrong), with the gist's page when there is one. */
function say(el, words, text, gist) {
  el.frame.hidden = true;
  el.frame.removeAttribute('srcdoc');
  el.status.hidden = false;
  el.message.textContent = text;
  el.home.textContent = words.home;
  el.home.setAttribute('href', words.homeHref);
  if (gist) fillBar(el, words, gist);
  else el.bar.hidden = true;
}

/** The viewer's language now: the shared page's, else the browser's. */
function browserLang() {
  return langOf(navigator.languages?.[0] ?? navigator.language);
}

/** Uses the shared page's icon (a data URL: the page loads nothing) as the viewer's. */
function useIcon(page) {
  const href = page.querySelector('link[rel~="icon"]')?.getAttribute('href');
  if (!href?.startsWith('data:')) return;
  const icon = document.querySelector('link[rel~="icon"]');
  if (icon) icon.setAttribute('href', href);
}

const ASK = { credentials: 'omit', referrerPolicy: 'no-referrer' };

/**
 * The gist's page: from the raw files under its owner, or, when they have none there (the owner
 * renamed since) or the owner is not known, where GitHub's API says it is. `{ gist, html }`, the gist
 * with its owner as GitHub has it now; or `{ failure }`. Throws when GitHub cannot be reached at all.
 */
export async function readPage(gist, get = fetch) {
  let res = gist.owner === undefined ? undefined : await get(rawUrl(gist), ASK);
  if (!res || res.status === 404) {
    // The raw files said it is not there: whatever the API cannot say (its limit reached, or out of
    // reach), it is not found.
    const notFound = { failure: { kind: 'notFound' } };
    let api;
    try {
      api = await get(apiUrl(gist.id), ASK);
    } catch (err) {
      if (res) return notFound;
      throw err;
    }
    const failure = failureOf(api.status);
    if (failure) return res ? notFound : { failure };
    const found = pageFromApi(await api.json().catch(() => undefined), gist.id);
    if (!found) return notFound;
    gist = { owner: found.owner, id: gist.id };
    res = await get(found.raw, ASK);
  }
  const failure = failureOf(res.status);
  return failure ? { failure, gist } : { gist, html: await res.text() };
}

let shown = 0;

async function show() {
  const run = ++shown;
  const el = parts(document);
  let gist = gistOf(location.hash);
  let lang = browserLang();
  let words = WORDS[lang];
  document.documentElement.lang = lang;
  document.title = words.title;
  if (!gist) return say(el, words, words.invalid);
  say(el, words, words.loading, gist);

  let read;
  try {
    read = await readPage(gist);
  } catch {
    if (run === shown) say(el, words, words.failed(words.offline), gist);
    return;
  }
  if (run !== shown) return;
  gist = read.gist ?? gist;
  if (read.failure) return say(el, words, read.failure.kind === 'notFound' ? words.notFound : words.failed(read.failure.detail), gist);

  // Parsed here only to read it and point its links: a parsed document runs nothing and loads nothing.
  const page = new DOMParser().parseFromString(read.html, 'text/html');
  lang = langOf(page.documentElement.getAttribute('lang') || lang);
  words = WORDS[lang];
  document.documentElement.lang = lang;
  if (!isSharedPage(page.querySelector('meta[name="generator"]')?.getAttribute('content'))) return say(el, words, words.notShared, gist);
  for (const a of page.querySelectorAll('a[href], area[href]')) {
    const plan = linkPlan(a.getAttribute('href'));
    a.setAttribute('href', plan.href);
    if (plan.target) {
      a.setAttribute('target', plan.target);
      a.setAttribute('rel', plan.rel);
    } else {
      a.removeAttribute('target');
    }
  }
  document.title = page.title.trim() || words.title;
  useIcon(page);
  fillBar(el, words, gist);
  el.status.hidden = true;
  el.frame.title = document.title;
  // The doctype too, or the frame lays the page out in quirks mode.
  el.frame.srcdoc = `<!doctype html>\n${page.documentElement.outerHTML}`;
  el.frame.hidden = false;
}

if (typeof document !== 'undefined') {
  window.addEventListener('hashchange', () => void show());
  void show();
}
