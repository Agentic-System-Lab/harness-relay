/**
 * What the desktop app needs of the server, checked over HTTP: it serves the web app, refuses the API
 * to a browser that is not signed in, and gives the app sign-in links for its own address that sign
 * a browser in; given stand-ins for the CLIs, its agents also answer a question. Used by
 * desktop/scripts/smoke.ts (the bundled server under plain Node, in CI and the tests) and by the
 * packaged app's own check (`--smoke-test`, main.ts; desktop/scripts/check-package.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ChatMessage, Conversation, ConversationSummary, Provider } from '../../src/shared/types';

/** Records a check that passed, or throws for one that did not. */
export type Check = (ok: unknown, what: string) => void;

/** A signed-in browser: what each of its requests sends. */
export interface SignedIn {
  cookie: string;
  key: string;
}

export async function checkServer(base: string, signInLink: () => Promise<string | undefined>, check: Check): Promise<SignedIn> {
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
  return { cookie: cookie!, key: key! };
}

/** The server's output must not hold a sign-in code: it is the app's log, which agents may read. */
export function printsNoCode(output: string): boolean {
  return !/Sign this browser in|#code=/.test(output);
}

/** The CLIs a turn asks: one for each way Harness Relay drives a CLI (stream-json, app-server, ACP). */
export const TURN_CLIS: readonly Provider[] = ['claude', 'codex', 'grok'];

/**
 * The server's environment for a turn with stand-ins for the CLIs (e2e/fake-cli/, installed in
 * `fakeDir` by e2e/support/fake-cli.ts): they come first on its PATH, found by name as the real ones
 * are, and the home folder and the CLIs' own homes are folders in `root`, so that nothing of the
 * user's own CLIs is read or changed. Returns the environment and the folder to work in.
 */
export function withFakeClis(env: NodeJS.ProcessEnv, fakeDir: string, root: string): { env: NodeJS.ProcessEnv; cwd: string } {
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const out: NodeJS.ProcessEnv = { ...env };
  // Windows spells it Path; a second spelling would leave the server one of the two.
  const pathKey = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  out[pathKey] = [fakeDir, out[pathKey]].filter(Boolean).join(delimiter);
  Object.assign(out, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    GROK_HOME: join(home, '.grok'),
  });
  for (const dir of [out.XDG_CONFIG_HOME!, out.CLAUDE_CONFIG_DIR!, out.CODEX_HOME!, out.GROK_HOME!, cwd]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, 'README.md'), '# Smoke test\n\nThe folder the desktop app check asks its agents a question in.\n');
  return { env: out, cwd };
}

/**
 * Asks a team of the three CLIs a question in a read-only chat in `cwd`, as the chat does, and
 * checks that each one answers it: the server finds and starts each CLI, talks its protocol, streams
 * the reply into the conversation and ends the run. Meant for the stand-ins of `withFakeClis()`,
 * which repeat the question in their answer; never for the real CLIs.
 */
export async function checkTurn(base: string, auth: SignedIn, check: Check, o: { cwd: string; timeoutMs?: number }): Promise<void> {
  const headers = { Cookie: auth.cookie, 'x-relay-key': auth.key, 'x-relay-lang': 'en', Origin: base };
  const request = async (path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown; text: string }> => {
    const r = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON: the text says what went wrong */
    }
    return { ok: r.ok, status: r.status, json, text };
  };
  const said = (what: string, r: { ok: boolean; status: number; text: string }) => (r.ok ? what : `${what} (${r.status} ${r.text.slice(0, 500)})`);

  const names = TURN_CLIS.join(', ').replace(/, (?=[^,]*$)/, ' and ');
  const created = await request('/api/conversations', {
    title: 'Desktop app check',
    agents: TURN_CLIS.map((provider, i) => {
      const name = provider[0]!.toUpperCase() + provider.slice(1);
      return { id: `a${i + 1}`, name, provider, role: `You are ${name}.` };
    }),
    settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: o.cwd },
  });
  const id = (created.json as Conversation | undefined)?.id;
  check(created.ok && id, said(`starts a read-only chat with ${names}`, created));

  const question = `Can you hear me? (check ${Math.random().toString(36).slice(2, 10)})`;
  const sent = await request(`/api/conversations/${id}/messages`, { text: question });
  check(sent.status === 202, said('sends them a question', sent));

  // Until the run is over: no member replying, nothing streaming.
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  let conv: Conversation | undefined;
  let over = false;
  while (!over && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const [one, all] = await Promise.all([request(`/api/conversations/${id}`), request('/api/conversations')]);
    conv = one.json as Conversation | undefined;
    const summary = (all.json as ConversationSummary[] | undefined)?.find((c) => c.id === id);
    over = !!conv?.messages && !!summary && !summary.running && conv.messages.every((m) => m.status !== 'streaming');
  }
  check(over, `the team's run ends within ${Math.round((o.timeoutMs ?? 90_000) / 1000)} s`);

  for (const provider of TURN_CLIS) {
    const reply = conv!.messages.find((m): m is ChatMessage => m.author.kind === 'agent' && m.provider === provider);
    const text = (reply?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
    const ok = reply?.status === 'done' && text.includes(question);
    const what = `${provider} answers it`;
    check(ok, ok ? what : `${what} (${reply ? `${reply.status}${reply.error ? `: ${reply.error}` : ''}: ${JSON.stringify(text.slice(0, 300))}` : 'no reply'})`);
  }
}
