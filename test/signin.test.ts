import { describe, expect, it } from 'vitest';
import { inDesktopWindow, pageStart, signInWhere, signInWithLink, type LinkDeps } from '../src/web/signin';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const APP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) harness-relay/2026.1110.0 Chrome/140.0.0.0 Electron/45.2.3 Safari/537.36';

describe('where the sign-in page points', () => {
  it("knows the desktop app's window by Electron in its user agent", () => {
    expect(inDesktopWindow(APP)).toBe(true);
    expect(inDesktopWindow(CHROME)).toBe(false);
    expect(inDesktopWindow('')).toBe(false);
  });

  it('points at the terminal for a server started there, whatever the browser', () => {
    expect(signInWhere({ desktopServer: false, userAgent: CHROME })).toBe('terminal');
    expect(signInWhere({ desktopServer: false, userAgent: APP })).toBe('terminal');
  });

  it("points the app's window at Open Harness Relay, and a browser at Open in browser", () => {
    expect(signInWhere({ desktopServer: true, userAgent: APP })).toBe('desktop-window');
    expect(signInWhere({ desktopServer: true, userAgent: CHROME })).toBe('desktop-browser');
  });
});

/**
 * A page at `hash`, on a server that takes `good` once and says whether the browser is signed in
 * (or fails to, with `statusFails`). `calls` records what the page asked for, in order.
 */
function fakePage(hash: string, o: { good?: string; signedIn?: boolean; desktop?: boolean; statusFails?: boolean } = {}) {
  const page = { hash, signedIn: o.signedIn ?? false, calls: [] as string[] };
  const deps: LinkDeps = {
    status: async () => {
      page.calls.push('status');
      if (o.statusFails) throw new Error('offline');
      return { signedIn: page.signedIn, desktop: o.desktop };
    },
    signIn: async (code) => {
      page.calls.push(`signIn ${code}`);
      if (code !== o.good) throw new Error('wrong code');
      o.good = undefined;
      page.signedIn = true;
    },
    hash: () => page.hash,
    dropCode: () => {
      page.calls.push('dropCode');
      page.hash = '#/';
    },
  };
  return { page, deps };
}

describe('signing in with a link', () => {
  it('takes the code out of the address, then signs in with it', async () => {
    const { page, deps } = fakePage('#code=ABCD-EFGH', { good: 'ABCD-EFGH' });
    expect(await signInWithLink(deps)).toEqual({ signedIn: true });
    expect(page.hash).toBe('#/');
    expect(page.calls).toEqual(['dropCode', 'signIn ABCD-EFGH']);
  });

  it('does nothing without a code', async () => {
    const { page, deps } = fakePage('#/chat/abc');
    expect(await signInWithLink(deps)).toBeUndefined();
    expect(page.hash).toBe('#/chat/abc');
    expect(page.calls).toEqual([]);
  });

  it('gives the error of a code that does not work, and takes that code out of the address too', async () => {
    const { page, deps } = fakePage('#code=WXYZ-0000');
    expect(await signInWithLink(deps)).toEqual({ signedIn: false, error: 'wrong code' });
    expect(page.hash).toBe('#/');
    expect(page.calls).toEqual(['dropCode', 'signIn WXYZ-0000', 'status']);
    // Also when the server cannot say whether the browser is signed in.
    expect(await signInWithLink(fakePage('#code=WXYZ-0000', { statusFails: true }).deps)).toEqual({
      signedIn: false,
      error: 'wrong code',
    });
  });

  it('changes nothing for a browser signed in already, known or asked', async () => {
    const known = fakePage('#code=WXYZ-0000');
    expect(await signInWithLink(known.deps, true)).toEqual({ signedIn: true });
    expect(known.page.calls).toEqual(['dropCode', 'signIn WXYZ-0000']);
    const asked = fakePage('#code=WXYZ-0000', { signedIn: true });
    expect(await signInWithLink(asked.deps)).toEqual({ signedIn: true });
    expect(asked.page.calls).toEqual(['dropCode', 'signIn WXYZ-0000', 'status']);
  });
});

describe("the page's first check", () => {
  it('goes by the server without a link, and says whether the desktop app started it', async () => {
    expect(await pageStart(fakePage('#/').deps)).toEqual({ signedIn: false, desktop: false });
    expect(await pageStart(fakePage('#/', { signedIn: true, desktop: true }).deps)).toEqual({ signedIn: true, desktop: true });
  });

  it('shows the sign-in page when the server cannot say', async () => {
    expect(await pageStart(fakePage('#/', { statusFails: true }).deps)).toEqual({ signedIn: false, desktop: false });
  });

  it('signs in with the link the page opened with, asking the server once', async () => {
    const { page, deps } = fakePage('#code=ABCD-EFGH', { good: 'ABCD-EFGH', desktop: true });
    expect(await pageStart(deps)).toEqual({ signedIn: true, desktop: true });
    expect(page.hash).toBe('#/');
    expect(page.calls).toEqual(['status', 'dropCode', 'signIn ABCD-EFGH']);
  });

  it('shows the error of a link that does not work', async () => {
    expect(await pageStart(fakePage('#code=WXYZ-0000').deps)).toEqual({ signedIn: false, desktop: false, error: 'wrong code' });
    expect(await pageStart(fakePage('#code=WXYZ-0000', { desktop: true }).deps)).toEqual({
      signedIn: false,
      desktop: true,
      error: 'wrong code',
    });
  });
});
