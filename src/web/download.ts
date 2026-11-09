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
