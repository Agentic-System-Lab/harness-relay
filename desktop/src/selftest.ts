/**
 * What the desktop app needs of the server, checked over HTTP: it serves the web app, refuses the API
 * to a browser that is not signed in, and gives the app sign-in links for its own address that sign
 * a browser in. Used by desktop/scripts/smoke.ts (the bundled server under plain Node, in CI and the
 * tests) and by the packaged app's own check (`--smoke-test`, main.ts; desktop/scripts/check-package.ts).
 */

/** Records a check that passed, or throws for one that did not. */
export type Check = (ok: unknown, what: string) => void;

export async function checkServer(base: string, signInLink: () => Promise<string | undefined>, check: Check): Promise<void> {
  const page = await fetch(`${base}/`);
  check(page.ok && (await page.text()).includes('<title>Harness Relay'), 'serves the web app');

  const signedOut = await fetch(`${base}/api/settings`);
  check(signedOut.status === 401, 'refuses the API to a browser that is not signed in');

  const link = await signInLink();
  check(link?.startsWith(`${base}/#code=`), 'gives a sign-in link for its own address');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ code: decodeURIComponent(link!.slice(`${base}/#code=`.length)) }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const { key } = (await login.json()) as { key?: string };
  check(login.ok && cookie && key, "signs a browser in with the link's code");
  const settings = await fetch(`${base}/api/settings`, { headers: { Cookie: cookie!, 'x-relay-key': key!, Origin: base } });
  check(settings.ok, 'answers the signed-in browser');
}

/** The server's output must not hold a sign-in code: it is the app's log, which agents may read. */
export function printsNoCode(output: string): boolean {
  return !/Sign this browser in|#code=/.test(output);
}
