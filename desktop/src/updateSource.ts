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
import { UPDATES_REPO } from '../../site/assets/downloads.js';

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

/** A GitHub token as it is sent in a header: letters, digits and `_` only (github_pat_…, ghp_…). */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

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
  if (token !== undefined && !TOKEN.test(token)) {
    return { ok: false, error: 'RELAY_UPDATES_TOKEN: not a GitHub token (letters, digits and _ only, such as github_pat_…)' };
  }
  return { ok: true, value: token ? { repo, token } : { repo } };
}
