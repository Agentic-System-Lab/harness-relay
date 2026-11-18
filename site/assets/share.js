// Harness Relay's viewer of a shared conversation (site/share/): the page Share made, a secret gist on
// GitHub that the link names after its `#` (`#<owner>/<id>`, never sent to any server). It reads the
// gist's file from GitHub's raw files (gist.githubusercontent.com), not from GitHub's API, which lets
// a browser that is not signed in ask only 60 times an hour (gistpreview.github.io, which shared pages
// were read on before, reads the API), and shows it in a frame that runs no script and has an origin
// of its own (`sandbox` without `allow-scripts` or `allow-same-origin`), so a gist can never run
// anything on this website. Its functions are tested in test/site-share.test.ts.

/** Where GitHub serves a gist's files as they are (as text, with CORS: any page may read them). */
export const RAW_HOST = 'https://gist.githubusercontent.com/';

/** The page's file in its gist (`SHARE_FILE` in src/server/share.ts). */
export const SHARE_FILE = 'index.html';

/** A GitHub account's name, as gist addresses have it. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A gist's id, as Harness Relay's shares have them (`validGistId` in src/server/share.ts). */
const GIST_ID = /^[0-9a-f]{20,}$/;

/** The gist a viewer address's fragment names (`#<owner>/<id>`), or undefined. */
export function gistOf(hash) {
  if (typeof hash !== 'string') return undefined;
  const parts = hash.replace(/^#/, '').replace(/\/$/, '').split('/');
  if (parts.length !== 2) return undefined;
  let owner;
  let id;
  try {
    [owner, id] = parts.map((p) => decodeURIComponent(p));
  } catch {
    return undefined;
  }
  return OWNER.test(owner) && GIST_ID.test(id) ? { owner, id } : undefined;
}

/** The gist's page file, as GitHub serves it raw (its newest version). */
export function rawUrl(gist) {
  return `${RAW_HOST}${encodeURIComponent(gist.owner)}/${encodeURIComponent(gist.id)}/raw/${SHARE_FILE}`;
}

/** The gist's own page on GitHub. */
export function gistPage(gist) {
  return `https://gist.github.com/${encodeURIComponent(gist.owner)}/${encodeURIComponent(gist.id)}`;
}

/** The viewer's language for a language tag: Traditional Chinese for any Chinese, else English. */
export function langOf(tag) {
  return typeof tag === 'string' && /^zh(?:-|$)/i.test(tag.trim()) ? 'zh-TW' : 'en';
}

/** What the viewer says, in its two languages. */
export const WORDS = {
  en: {
    title: 'Shared conversation · Harness Relay',
    loading: 'Loading the shared conversation…',
    sharedBy: (owner) => ['Shared by ', `@${owner}`, ' as a secret GitHub gist'],
    viewGist: 'View on GitHub',
    invalid: 'This address does not name a shared conversation. Check that the link was copied whole.',
    notFound: 'This shared conversation is not on GitHub: it was removed, or the link was not copied whole.',
    failed: (detail) => `Could not load the shared conversation from GitHub (${detail}). Try again in a moment.`,
    offline: 'no connection',
    home: "Harness Relay's website",
    homeHref: '../',
  },
  'zh-TW': {
    title: '分享的對話 · Harness Relay',
    loading: '正在載入分享的對話…',
    sharedBy: (owner) => ['由 ', `@${owner}`, ' 以 GitHub 的 secret gist 分享'],
    viewGist: '在 GitHub 上查看',
    invalid: '這個網址沒有指向分享的對話。請確認連結有完整複製。',
    notFound: 'GitHub 上沒有這個分享的對話：它已被移除，或連結沒有完整複製。',
    failed: (detail) => `無法從 GitHub 載入分享的對話（${detail}）。請稍後再試。`,
    offline: '沒有網路連線',
    home: 'Harness Relay 網站',
    homeHref: '../zh-TW/',
  },
};

/**
 * A link's address as the frame takes it. A link within the page (`#…`, a review point's @name) would
 * resolve against this viewer's address in a srcdoc frame, and open the viewer in it: pointed at the
 * frame's own document instead, it scrolls there, and its words match `:target`.
 */
export function framedHref(href) {
  return typeof href === 'string' && href.startsWith('#') ? `about:srcdoc${href}` : href;
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

/** The bar's words: who shared it, and the gist's page on GitHub. */
function fillBar(el, words, gist) {
  const [before, owner, after] = words.sharedBy(gist.owner);
  const name = document.createElement('b');
  name.textContent = owner;
  el.by.replaceChildren(before, name, after);
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

let shown = 0;

async function show() {
  const run = ++shown;
  const el = parts(document);
  const gist = gistOf(location.hash);
  let lang = browserLang();
  let words = WORDS[lang];
  document.documentElement.lang = lang;
  document.title = words.title;
  if (!gist) return say(el, words, words.invalid);
  say(el, words, words.loading, gist);

  let html;
  try {
    const res = await fetch(rawUrl(gist), { credentials: 'omit', referrerPolicy: 'no-referrer' });
    const failure = failureOf(res.status);
    if (failure) {
      if (run === shown) say(el, words, failure.kind === 'notFound' ? words.notFound : words.failed(failure.detail), gist);
      return;
    }
    html = await res.text();
  } catch {
    if (run === shown) say(el, words, words.failed(words.offline), gist);
    return;
  }
  if (run !== shown) return;

  // Parsed here only to read it and point its links within the page at the frame: a parsed document
  // runs nothing and loads nothing.
  const page = new DOMParser().parseFromString(html, 'text/html');
  for (const a of page.querySelectorAll('a[href^="#"], area[href^="#"]')) a.setAttribute('href', framedHref(a.getAttribute('href')));
  lang = langOf(page.documentElement.getAttribute('lang') || lang);
  words = WORDS[lang];
  document.documentElement.lang = lang;
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
