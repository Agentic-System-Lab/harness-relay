import { codeFromHash } from '../shared/auth';

/**
 * Where the sign-in page tells someone to get a sign-in link (components/SignIn.tsx): the terminal
 * the server was started in, or, for a server the desktop app started, the app's menu. The app's own
 * window signs in again from its menu item that opens it; a browser, from the one that opens the chat
 * in the browser.
 */
export type SignInWhere = 'terminal' | 'desktop-window' | 'desktop-browser';

/** Whether the page is in the desktop app's window: Electron names itself in the user agent. */
export function inDesktopWindow(userAgent: string): boolean {
  return /\bElectron\/\d/.test(userAgent);
}

/** `desktopServer`: GET /api/auth said the desktop app started the server. */
export function signInWhere(o: { desktopServer: boolean; userAgent: string }): SignInWhere {
  if (!o.desktopServer) return 'terminal';
  return inDesktopWindow(o.userAgent) ? 'desktop-window' : 'desktop-browser';
}

/** What the page needs to sign in with a link: the API's two calls and the address. */
export interface LinkDeps {
  /** GET /api/auth. */
  status(): Promise<{ signedIn: boolean; desktop?: boolean }>;
  /** POST /api/auth/login: rejects when the code does not work. */
  signIn(code: string): Promise<void>;
  /** The address's fragment (`location.hash`). */
  hash(): string;
  /** Takes the code out of the address, so it stays in neither the history nor a shared link. */
  dropCode(): void;
}

/** Signed in or not after a link; `error` says why a link did not sign this browser in. */
export interface LinkResult {
  signedIn: boolean;
  error?: string;
}

/** Whether the server knows this browser (GET /api/auth); not when it cannot say. */
export async function askSignedIn(d: LinkDeps): Promise<boolean> {
  return (await d.status().catch(() => ({ signedIn: false }))).signedIn;
}

/**
 * Signs in with the code a sign-in link carries (`#code=…`), and takes it out of the address;
 * undefined when the address has none. The code is used up also in a browser signed in already (its
 * new session replaces the old one), so it does not keep working in the browser's history. A link
 * that no longer works changes nothing for a browser that is signed in: `signedIn` says whether it
 * is, read once the code has failed (a failed code leaves the session as it was); else the server is
 * asked.
 */
export async function signInWithLink(
  d: LinkDeps,
  signedIn: () => boolean | Promise<boolean> = () => askSignedIn(d),
): Promise<LinkResult | undefined> {
  const code = codeFromHash(d.hash());
  if (!code) return undefined;
  d.dropCode();
  try {
    await d.signIn(code);
    return { signedIn: true };
  } catch (e) {
    if (await signedIn()) return { signedIn: true };
    return { signedIn: false, error: (e as Error).message };
  }
}

/** Where the page starts: signed in or not, and whether the desktop app started the server. */
export interface PageStart extends LinkResult {
  desktop: boolean;
}

/**
 * The page's first check: the server's word, then the link the page opened with, if any (the desktop
 * app always opens it with one). The server is asked once, also for a link that does not work.
 */
export async function pageStart(d: LinkDeps): Promise<PageStart> {
  const status = await d.status().catch(() => ({ signedIn: false, desktop: false }));
  const desktop = status.desktop === true;
  const link = await signInWithLink(d, () => status.signedIn);
  return link ? { ...link, desktop } : { signedIn: status.signedIn, desktop };
}

/** Where the page keeps its first check while it runs (a React ref). */
export interface HeldCheck {
  current: Promise<PageStart> | undefined;
}

/**
 * One run of the page's first effect: shows the first check (`pageStart`) when it is done, unless the
 * run has ended by then (the function it returns ends it). Runs share the check while it runs: React
 * runs the effect twice in development (StrictMode), ending the first run at once, and a check of the
 * second run's own would find the link's code gone from the address and go by a status asked before
 * the first one's sign-in, showing the sign-in page to a browser the link had just signed in. The run
 * that shows the check lets it go, so a run after it checks again rather than shows an old result.
 */
export function runFirstCheck(held: HeldCheck, d: LinkDeps, show: (s: PageStart) => void): () => void {
  let live = true;
  const first = (held.current ??= pageStart(d));
  void first.then((s) => {
    if (!live) return;
    if (held.current === first) held.current = undefined;
    show(s);
  });
  return () => {
    live = false;
  };
}

/** What the page needs to follow another tab's change to the key (`afterOtherTab`). */
export interface OtherTabDeps {
  /** Whether the server knows this browser, with the key this tab has now (`askSignedIn`). */
  signedIn(): Promise<boolean>;
  /** The key this tab has now: the one kept, else the one it holds itself (`readKey`). */
  key(): string | null;
  /** Keeps a key again (`writeKey`). */
  keep(key: string): void;
}

/**
 * After another tab of this browser changed the key (`keyChange`); true when this tab is to show the
 * app. Tabs share the cookie and the key, so:
 * - A new key: another tab signed this browser in, so the server is asked, and a tab showing the
 *   sign-in page shows the app when it is signed in. It was shown there when a sign-in link opened
 *   in another tab ended the session this tab was using, before that tab kept its new key.
 * - The key gone while this tab still holds one: the server is asked with it, and it is kept again
 *   when it still works. Another tab cleared the key of the session this tab's sign-in had just
 *   replaced, and that came after this tab kept the new one (each tab's copy of the storage learns of
 *   the other's changes a moment late).
 */
export async function afterOtherTab(change: 'arrived' | 'removed' | undefined, d: OtherTabDeps): Promise<boolean> {
  if (change === 'arrived') return d.signedIn();
  if (change !== 'removed') return false;
  const mine = d.key();
  if (mine === null || !(await d.signedIn())) return false;
  // Not over a key another sign-in kept meanwhile.
  if (d.key() === mine) d.keep(mine);
  return false;
}
