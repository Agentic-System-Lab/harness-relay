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

/** What fetching `copiesReadable` needs: the global fetch, or a stand-in for it. */
export type CopiesFetch = (url: string, init: { headers: Record<string, string>; redirect: 'error' }) => Promise<Response>;

/**
 * Why an app built with `source` could not download the copies named `copies` (file names) of the
 * release tagged `tag`, or undefined when it could: GitHub's API is asked for that release as the app
 * asks it (with the token for a private repository), and each copy must be listed with its id. The
 * Release workflow runs this once it published the copies and before the release itself, so that a
 * read token missing, expired, waiting for an organization's approval or without access to that
 * repository stops the release, instead of every update quietly counting as a new install. Without a
 * token in `source`, it asks with `token` (the workflow's own: it reads a public repository, and no
 * other's private one), so that GitHub's limit on requests without one does not get in the way. Its
 * answer never names a token.
 */
export async function copiesReadable(fetch: CopiesFetch, o: { source: UpdateSource; tag: string; copies: string[]; token?: string }): Promise<string | undefined> {
  const { repo } = o.source;
  const token = o.source.token ?? o.token;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(o.tag)}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: 'error',
    });
  } catch (err) {
    return `GitHub could not be asked for the release ${o.tag} in ${repo}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!res.ok) {
    const limited = res.status === 403 || res.status === 429 ? ", or GitHub's limit on requests was reached" : '';
    return o.source.token
      ? `The app's token (UPDATES_READ_TOKEN) cannot read the release ${o.tag} in ${repo} (GitHub answered ${res.status}): it has no access to that repository, has expired or was revoked, or waits for the organization's approval${limited}`
      : `The release ${o.tag} in ${repo} cannot be read without a token of its own (GitHub answered ${res.status}): for a private repository, set the UPDATES_READ_TOKEN secret${limited}`;
  }
  const release = (await res.json().catch(() => null)) as { assets?: { id?: unknown; name?: unknown }[] } | null;
  const ids = new Map((Array.isArray(release?.assets) ? release.assets : []).map((a) => [a?.name, a?.id]));
  const missing = o.copies.filter((name) => {
    const id = ids.get(name);
    return !(typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  });
  return missing.length ? `The release ${o.tag} in ${repo} does not list ${missing.join(', ')}` : undefined;
}
