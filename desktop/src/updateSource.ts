/**
 * Where the desktop app downloads its updates from: the repository (`owner/name`) whose releases hold
 * the installers' copies for updates (update.ts; the versions and their checksums are always read from
 * this repository's own releases), and, for a private one, a token the copies are downloaded with on
 * GitHub's API. Both are fixed when the app is built (desktop/scripts/build.ts, from RELAY_UPDATES_REPO
 * and RELAY_UPDATES_TOKEN; the Release workflow sets them from the repository variable UPDATES_REPO and
 * the secret UPDATES_READ_TOKEN), never read when the app runs: nothing on the computer it runs on can
 * point it elsewhere. Where the copies cannot be had, the app downloads the installers themselves.
 *
 * The token goes into every copy of the app, where anyone who has one can read it: give it nothing
 * but read access to the contents of that one repository (docs/developer-guide.md, "Releasing").
 */
import { createHash } from 'node:crypto';
import { REPO as MAIN_REPO, UPDATES_REPO } from '../../site/assets/downloads.js';

export interface UpdateSource {
  /** The repository whose releases hold the copies for the app's updates, as `owner/name`. */
  repo: string;
  /** A token the copies are downloaded with on GitHub's API, for a private repository; none for a public one. */
  token?: string;
}

/** Where an app built without RELAY_UPDATES_REPO downloads its updates: UPDATES_REPO, without a token. */
export const DEFAULT_UPDATE_SOURCE: UpdateSource = { repo: UPDATES_REPO };

/** An owner (letters, digits and single hyphens inside) and a repository name (letters, digits, `.`, `_`, `-`). */
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;

/**
 * A fine-grained personal access token (github_pat_…), as it is sent in a header: letters, digits and
 * `_` only. No other kind: a classic token (ghp_…) or an OAuth one (gho_…) cannot be kept to one
 * repository, and the token goes into every copy of the app.
 */
const TOKEN = /^github_pat_[A-Za-z0-9_]{20,244}$/;

/**
 * The update source an environment names (RELAY_UPDATES_REPO, RELAY_UPDATES_TOKEN, each trimmed; an
 * empty one is not set), or why it cannot be used. The token never appears in an error.
 */
export function updateSourceFrom(env: Record<string, string | undefined>): { ok: true; value: UpdateSource } | { ok: false; error: string } {
  const repo = env.RELAY_UPDATES_REPO?.trim() || DEFAULT_UPDATE_SOURCE.repo;
  const token = env.RELAY_UPDATES_TOKEN?.trim() || undefined;
  const parts = REPO.exec(repo);
  if (!parts || /^\.+$/.test(parts[2]!) || parts[2]!.endsWith('.git')) {
    return { ok: false, error: `RELAY_UPDATES_REPO: "${repo}" is not a GitHub repository as owner/name (Agentic-System-Lab/harness-relay-updates, say)` };
  }
  // GitHub's names are the same in any letter case.
  if (repo.toLowerCase() === MAIN_REPO.toLowerCase()) {
    return { ok: false, error: `RELAY_UPDATES_REPO: the copies go in a repository of their own, not in ${MAIN_REPO}, whose releases hold the installers alone` };
  }
  if (token !== undefined && !TOKEN.test(token)) {
    return {
      ok: false,
      error: 'RELAY_UPDATES_TOKEN: not a fine-grained personal access token (github_pat_…): any other kind cannot be kept to one repository, and it goes into every copy of the app',
    };
  }
  return { ok: true, value: token ? { repo, token } : { repo } };
}

/**
 * The update source as the build puts it into the app (`__RELAY_UPDATE_SOURCE__` in main.cjs): the token
 * encoded (`encodeUpdateSource`). Not to keep it secret, which it cannot be, but so that it never stands
 * in the app as a token's text: GitHub revokes a token it finds pushed to a public repository or gist,
 * and anyone could push an unpacked app.
 */
export interface BuiltUpdateSource {
  repo: string;
  /** The token's UTF-8 bytes in base64, reversed. */
  encodedToken?: string;
}

/** `source` as the build puts it into the app (`BuiltUpdateSource`). */
export function encodeUpdateSource(source: UpdateSource): BuiltUpdateSource {
  if (!source.token) return { repo: source.repo };
  return { repo: source.repo, encodedToken: [...Buffer.from(source.token, 'utf8').toString('base64')].reverse().join('') };
}

/** The update source an app was built with, from what the build put into it (`encodeUpdateSource`). */
export function decodeUpdateSource(built: BuiltUpdateSource): UpdateSource {
  if (!built.encodedToken) return { repo: built.repo };
  return { repo: built.repo, token: Buffer.from([...built.encodedToken].reverse().join(''), 'base64').toString('utf8') };
}

/**
 * What an app was built to download its updates with, as a SHA-256 that names neither: written next to
 * the build (desktop/scripts/build.ts, `update-source.txt`) and compared by the Release workflow with
 * this run's (`sameUpdateSource`). The repository in any letter case, as GitHub takes it.
 */
export function updateSourceFingerprint(source: UpdateSource): string {
  return createHash('sha256').update(JSON.stringify([source.repo.toLowerCase(), source.token ?? ''])).digest('hex');
}

/**
 * Why the installers a run is about to publish were not all built with `source` (the fingerprints their
 * builds wrote, `built`, one for each of the `installers`), or undefined when they were. "Re-run failed
 * jobs" builds nothing again that built before, so a secret or a variable changed in between would
 * otherwise be checked (`copiesReadable`) and not be in the installers.
 */
export function sameUpdateSource(built: string[], source: UpdateSource, installers: number): string | undefined {
  const expected = updateSourceFingerprint(source);
  if (built.length === installers && built.every((f) => f.trim() === expected)) return undefined;
  return (
    `${built.filter((f) => f.trim() === expected).length} of the ${installers} installers were built to download their updates as this run would ` +
    `(the UPDATES_REPO variable and the UPDATES_READ_TOKEN secret as they are now): run the whole workflow again (Re-run all jobs), not only its failed jobs`
  );
}

/** What fetching `copiesReadable` needs: the global fetch, or a stand-in for it. */
export type CopiesFetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

/**
 * Why an app built with `source` could not download the copies (`copies`: each file's name and size)
 * of the release tagged `tag` (`error`, none when it could), and a `warning` when its token expires
 * soon (`expiryWarning`) or GitHub's limit on requests kept it from knowing. GitHub's API is asked for
 * that release, with the token for a private repository as the app asks, and each copy must be listed
 * with its id, whole (uploaded, at its size). The Release workflow runs this once it published the
 * copies and before the release itself, so that a read token missing, expired, waiting for an
 * organization's approval or without access to that repository stops the release, instead of every
 * update quietly counting as a new install. A failure of GitHub's (5xx, no answer) is asked again,
 * COPIES_TRIES times in all, and a 404 once more (a release just made may not be found at once); its
 * limit on requests, its secondary one too, is waited out when it ends soon (COPIES_LIMIT_WAIT_MS for
 * all the waits together), else left as a warning, since the apps then only update from the
 * installers; a repository moved (301) is said so. Without a token in `source` (the app
 * then downloads from github.com without signing in), it asks with `token` in its place (the
 * workflow's own: it reads a public repository, and no other's private one), so that GitHub's limit on
 * requests without one does not get in the way. Its answer never names a token, and says whether the
 * whole workflow must run again (a secret to change) or the failed job alone.
 */
export async function copiesReadable(
  fetch: CopiesFetch,
  o: {
    source: UpdateSource;
    tag: string;
    copies: { name: string; size?: number }[];
    token?: string;
    now?: Date;
    /** How a wait is made (tests pass one that only records it). */
    sleep?: (ms: number) => Promise<void>;
    /** How long one question may take (COPIES_REQUEST_TIMEOUT_MS). */
    timeoutMs?: number;
  },
): Promise<{ error?: string; warning?: string }> {
  const { repo } = o.source;
  const at = `the release ${o.tag} in ${repo}`;
  // A 404 asked once more: the release just made may not be found at once.
  const asked = await askGitHub(fetch, `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(o.tag)}`, o.source.token ?? o.token, { ...o, notFoundAgain: true });
  if ('limited' in asked) {
    return {
      warning:
        `GitHub's limit on requests (answered ${asked.limited}) kept ${at} from being checked: the copies were published, but whether an app can download them is not known. ` +
        'Until it can, apps update from the installers, their updates counting as new installs',
    };
  }
  if ('failure' in asked) {
    return { error: `GitHub could not be asked for ${at} (${asked.failure}), ${COPIES_TRIES} times: run the failed job again (Re-run failed jobs); nothing needs building again` };
  }
  const { res } = asked;
  if (res.status >= 300 && res.status < 400) {
    return {
      error:
        `The copies' repository ${repo} has moved (GitHub answered ${res.status}${res.headers.get('location') ? ` for ${res.headers.get('location')}` : ''}): ` +
        'set the UPDATES_REPO variable to its new name (owner/name), then run the whole workflow again (Re-run all jobs), so that the installers are built for it',
    };
  }
  if (!res.ok) {
    const again = ', then run the whole workflow again (Re-run all jobs, not only the failed ones), so that the installers are built with it';
    const slow = res.status === 404 ? ' If the release was only slow to appear, Re-run failed jobs is enough.' : '';
    return {
      error: o.source.token
        ? `The app's token (UPDATES_READ_TOKEN) cannot read ${at} (GitHub answered ${res.status}): it has no access to that repository, has expired or was revoked, or waits for the organization's approval. ` +
          `Set a token that can${again}. If it only waited for the organization's approval and has it now, Re-run failed jobs is enough: the installers already hold it.${slow}`
        : `${at[0]!.toUpperCase()}${at.slice(1)} cannot be read without a token of its own (GitHub answered ${res.status}): for a private repository, set the UPDATES_READ_TOKEN secret${again}.${slow}`,
    };
  }
  const warning = o.source.token ? expiryWarning(res.headers.get('github-authentication-token-expiration'), o.now ?? new Date()) : undefined;
  const release = (await res.json().catch(() => null)) as { assets?: { id?: unknown; name?: unknown; state?: unknown; size?: unknown }[] } | null;
  const listed = new Map((Array.isArray(release?.assets) ? release.assets : []).map((a) => [a?.name, a]));
  const missing = o.copies.filter(({ name, size }) => {
    const a = listed.get(name);
    const id = a?.id;
    const whole = a?.state === undefined || a.state === 'uploaded';
    const sized = size === undefined || a?.size === size;
    return !(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && whole && sized);
  });
  if (missing.length) {
    return {
      error: `The release ${o.tag} in ${repo} does not list ${missing.map((c) => c.name).join(', ')}, whole: run the failed job again (Re-run failed jobs), which uploads the copies again`,
      warning,
    };
  }
  return warning ? { warning } : {};
}

/**
 * Why the copies' repository of `source` cannot be read as an app built with it would (`error`), or a
 * `warning` when GitHub would not say: the Release workflow asks before anything is built, so that a
 * read token without access to it, expired, revoked or waiting for an organization's approval (or a
 * private repository without one) stops the run at once, not after the builds. Asked with the read
 * token, else with `token` in its place (the workflow's own), as `copiesReadable` asks. GitHub's
 * failures, its limit on requests or no answer leave a warning: the copies' check after the builds
 * asks again. Its answer never names a token.
 */
export async function repositoryReadable(
  fetch: CopiesFetch,
  o: { source: UpdateSource; token?: string; now?: Date; sleep?: (ms: number) => Promise<void>; timeoutMs?: number },
): Promise<{ error?: string; warning?: string }> {
  const { repo } = o.source;
  const asked = await askGitHub(fetch, `https://api.github.com/repos/${repo}`, o.source.token ?? o.token, o);
  const later = 'the copies\' check after the builds will ask again';
  if ('limited' in asked) return { warning: `GitHub's limit on requests (answered ${asked.limited}) kept the copies' repository ${repo} from being checked now: ${later}` };
  if ('failure' in asked) return { warning: `GitHub could not be asked for the copies' repository ${repo} (${asked.failure}): ${later}` };
  const { res } = asked;
  if (res.status >= 300 && res.status < 400) {
    return {
      error:
        `The copies' repository ${repo} has moved (GitHub answered ${res.status}${res.headers.get('location') ? ` for ${res.headers.get('location')}` : ''}): ` +
        'set the UPDATES_REPO variable to its new name (owner/name), then run the workflow again',
    };
  }
  if (!res.ok) {
    return {
      error: o.source.token
        ? `The app's token (UPDATES_READ_TOKEN) cannot read the copies' repository ${repo} (GitHub answered ${res.status}): it has no access to it, has expired or was revoked, or waits for the organization's approval. Set a token that can, or wait for the approval, then run the workflow again`
        : `The copies' repository ${repo} cannot be read without a token of its own (GitHub answered ${res.status}): for a private repository, set the UPDATES_READ_TOKEN secret, then run the workflow again`,
    };
  }
  return {};
}

/**
 * `url` asked of GitHub's API with `token` (none: without signing in), not following a redirect, each
 * try given up on after COPIES_REQUEST_TIMEOUT_MS: its answer (`res`), unless it failed (5xx, no
 * answer) COPIES_TRIES times (`failure`) or its limit on requests did not end within
 * COPIES_LIMIT_WAIT_MS, all the waits together (`limited`, the status it answered). With
 * `notFoundAgain`, a 404 is asked once more.
 */
async function askGitHub(
  fetch: CopiesFetch,
  url: string,
  token: string | undefined,
  o: { now?: Date; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; notFoundAgain?: boolean },
): Promise<{ res: Response } | { limited: number } | { failure: string }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let failure = '';
  let waited = 0;
  let notFound = 0;
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        // Not followed, so that the token goes nowhere else: a repository renamed or moved answers 301.
        redirect: 'manual',
        signal: AbortSignal.timeout(o.timeoutMs ?? COPIES_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (res?.ok) return { res };
    // GitHub's limit on requests (every installed app shares the read token's), its secondary limit too:
    // waited out while all the waits together come within COPIES_LIMIT_WAIT_MS.
    const wait = res ? await limitedFor(res, (o.now ?? new Date()).getTime()) : undefined;
    if (wait !== undefined) {
      if (attempt < COPIES_TRIES && waited + wait <= COPIES_LIMIT_WAIT_MS) {
        waited += wait;
        await sleep(wait);
        continue;
      }
      return { limited: res!.status };
    }
    if (res?.status === 404 && o.notFoundAgain && notFound++ === 0 && attempt < COPIES_TRIES) {
      await sleep(COPIES_RETRY_MS);
      continue;
    }
    // An answer of its own (a redirect, a refusal): no point asking again.
    if (res && res.status < 500) return { res };
    if (res) failure = `GitHub answered ${res.status}`;
    if (attempt >= COPIES_TRIES) return { failure };
    await sleep(COPIES_RETRY_MS * attempt);
  }
}

/** How many times `copiesReadable` asks GitHub when it fails (5xx, no answer) or limits its requests. */
export const COPIES_TRIES = 3;

/** How long one question to GitHub may take before it is given up on (and asked again). */
export const COPIES_REQUEST_TIMEOUT_MS = 30_000;

/** How long `copiesReadable` waits before asking again after a failure: this, then twice this. */
export const COPIES_RETRY_MS = 10_000;

/** The longest `copiesReadable` waits for GitHub's limit on requests to end, all its waits together, within the release job's time. */
export const COPIES_LIMIT_WAIT_MS = 5 * 60_000;

/**
 * How long until GitHub takes requests again, when `res` says its limit was reached (429, or 403 with
 * none left, one asking to retry after a while, or its secondary limit, which it names in the answer),
 * from `retry-after` or `x-ratelimit-reset`; else undefined. A limit whose end is not said counts as
 * one minute.
 */
async function limitedFor(res: Response, now: number): Promise<number | undefined> {
  const retryAfter = Number(res.headers.get('retry-after'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  let limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
  if (!limited && res.status === 403) limited = /secondary rate limit/i.test(await res.clone().text().catch(() => ''));
  if (!limited) return undefined;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + 1000;
  return 60_000;
}

/** How long before the app's token expires the Release workflow warns: what a release built with it has left to be updated from. */
export const EXPIRY_WARNING_DAYS = 90;

/**
 * A warning when the app's token expires within EXPIRY_WARNING_DAYS of `now`, from the expiry GitHub
 * gives with an answer to a request made with it (`github-authentication-token-expiration`, such as
 * `2026-12-31 23:59:59 UTC` or `… +0800`; none for a token that never expires): every installed app
 * built with it then counts its updates as new installs until it updates to a release built with a new
 * one. Undefined for a token that never expires, or an expiry it cannot read.
 */
export function expiryWarning(header: string | null, now: Date): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(header?.trim() ?? '');
  if (!m) return undefined;
  const zone = m[3] === 'UTC' ? 'Z' : `${m[3]!.slice(0, 3)}:${m[3]!.slice(3)}`;
  const at = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (Number.isNaN(at)) return undefined;
  const days = Math.floor((at - now.getTime()) / 86_400_000);
  if (days >= EXPIRY_WARNING_DAYS) return undefined;
  return (
    `The app's token (UPDATES_READ_TOKEN) expires on ${new Date(at).toISOString().slice(0, 10)}, in ${Math.max(days, 0)} days: from then on the apps built with it ` +
    'count their updates as new installs until they update to a release built with a new one. Set a new one and release with it before then, and revoke the old one later'
  );
}
