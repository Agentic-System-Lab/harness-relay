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
