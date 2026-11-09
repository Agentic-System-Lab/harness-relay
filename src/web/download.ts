// Files a reply links to: whether the server can hand one over, asked before the user clicks.

export type DownloadState = 'ok' | 'missing' | 'unknown';

/** How long a link waits before it is checked, so a URL still streaming in is not checked at every step. */
export const CHECK_DELAY_MS = 300;

/**
 * Whether the file at a download URL is there, by a HEAD request (nothing is downloaded): 'missing'
 * for a 404 (not in the working directory, or gone), 'unknown' when the server could not say (the
 * link then stays, since a click may still work).
 */
export async function checkDownload(url: string, fetchFn: typeof fetch = fetch): Promise<DownloadState> {
  try {
    const res = await fetchFn(url, { method: 'HEAD' });
    return res.ok ? 'ok' : res.status === 404 ? 'missing' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Checks a link after CHECK_DELAY_MS. Returns a function that cancels it (another URL, or the link
 * went away), after which `onState` is not called.
 */
export function checkLater(url: string, onState: (s: DownloadState) => void, fetchFn: typeof fetch = fetch): () => void {
  let current = true;
  const timer = setTimeout(() => {
    void checkDownload(url, fetchFn).then((s) => current && onState(s));
  }, CHECK_DELAY_MS);
  return () => {
    current = false;
    clearTimeout(timer);
  };
}

/**
 * What a click on a file link does: it downloads, except while the file is missing. Then it checks
 * again and, once the file is there, clicks the link again for the user; that second click goes
 * through. The returned function says whether a click may download (false: stop it).
 */
export function fileClicks(
  check: () => Promise<DownloadState>,
  onState: (s: DownloadState) => void,
): (state: DownloadState, link: { click(): void }) => boolean {
  let resend = false;
  return (state, link) => {
    if (resend) {
      resend = false;
      return true;
    }
    if (state !== 'missing') return true;
    void check().then((s) => {
      onState(s);
      if (s === 'missing') return;
      resend = true;
      link.click();
    });
    return false;
  };
}
