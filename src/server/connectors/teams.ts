import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, parse } from 'node:path';
import type { Writable } from 'node:stream';
import type { TeamsConnection } from '../../shared/types';
import { BREW_DIRS, findOnPath, isProgram } from '../executable';
import { t } from '../i18n';
import { LOGIN_TIMEOUT_MS } from '../login';
import { CommandNotFoundError, runProcess, stripAnsi, type SpawnOptions } from '../process';
import { CONNECT_TEAMS, INSTALL_TEAMS, PROBE_TEAMS } from './teamsPowerShell';

type Run = (
  script: string,
  options: Pick<SpawnOptions, 'signal' | 'timeoutMs' | 'onLine' | 'onSpawn' | 'keepStdinOpen'>,
) => Promise<number | null>;

const runPowerShell: Run = async (script, options) => {
  const env: NodeJS.ProcessEnv = {};
  // Keep OS, HTTPS proxy and certificate settings. Never inherit a PowerShell profile/module path,
  // .NET startup hooks, cloud service credentials, or npm's project-local bin directories.
  for (const [key, val] of Object.entries(process.env)) {
    if (
      /^(HOME|USERPROFILE|SYSTEMROOT|WINDIR|ProgramFiles(?:\(x86\))?|ProgramData|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|XDG_DATA_HOME|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|LANG)$/i.test(
        key,
      )
    )
      env[key] = val;
  }
  env.PATH = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((p) => isAbsolute(p) && !/(^|[/\\])node_modules([/\\]|$)/i.test(p))
    .join(delimiter);
  env.PATHEXT = '.EXE';
  const systemDirs =
    process.platform === 'win32'
      ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7')]
      : [...BREW_DIRS, '/usr/bin', '/usr/local/microsoft/powershell/7'];
  const bin = findOnPath('pwsh', env, process.platform, systemDirs, isProgram);
  if (!bin) throw new CommandNotFoundError('pwsh');
  // The SDK uses the .NET home for its account hint even when the token cache is process-scoped.
  const privateHome = script === CONNECT_TEAMS && process.platform !== 'win32' ? await mkdtemp(join(tmpdir(), 'relay-teams-')) : undefined;
  if (process.platform !== 'win32') {
    env.RELAY_TEAMS_USER_MODULES = join(
      env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share'),
      'powershell',
      'Modules',
    );
    if (privateHome) env.HOME = privateHome;
  }
  try {
    const result = await runProcess({
      ...options,
      bin,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      env,
      cwd: parse(homedir()).root,
      maxCapture: 512,
    });
    if (result.timedOut) throw new Error(t().timedOut);
    return result.code;
  } finally {
    if (privateHome) await rm(privateHome, { recursive: true, force: true }).catch(() => {});
  }
};

function dependency(code: number | null): TeamsConnection {
  if (code === 0) return { status: 'signed-out' };
  if (code === 20) return { status: 'missing-powershell' };
  if (code === 21) return { status: 'missing-module' };
  return { status: 'error', message: t().teamsSetupFailed };
}

function segment(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_:@.-]{1,300}$/.test(id) || id === '.' || id === '..') throw new Error(t().invalidField('id'));
  return encodeURIComponent(id);
}

interface Pending {
  finish(value?: string, error?: Error): void;
}

/** One explicit Teams device login and its process-scoped Graph session. No status or read starts a sign-in. */
export class TeamsGraph {
  private view?: TeamsConnection;
  private probe?: Promise<TeamsConnection>;
  private controller?: AbortController;
  private stdin?: Writable;
  private signInTimer?: NodeJS.Timeout;
  private readTimer?: NodeJS.Timeout;
  private sequence = 0;
  private pending = new Map<number, Pending>();

  constructor(private run: Run = runPowerShell) {}

  connected(): boolean {
    return this.view?.status === 'connected';
  }

  async status(): Promise<TeamsConnection> {
    if (this.view) return this.view;
    this.probe ??= this.run(PROBE_TEAMS, { timeoutMs: 15000 })
      .then(dependency, (err) => this.failure(err))
      .finally(() => {
        this.probe = undefined;
      });
    const available = await this.probe;
    return this.view ?? available;
  }

  async install(): Promise<TeamsConnection> {
    if (this.controller && this.view) return this.view;
    const controller = new AbortController();
    this.controller = controller;
    this.view = { status: 'installing' };
    void this.run(INSTALL_TEAMS, { signal: controller.signal, timeoutMs: 180000 }).then(
      (code) => this.end(controller, dependency(code)),
      (err) => this.end(controller, this.failure(err)),
    );
    return this.view;
  }

  async connect(): Promise<TeamsConnection> {
    if (this.controller && this.view) return this.view;
    const controller = new AbortController();
    this.controller = controller;
    this.view = { status: 'signing-in' };
    this.signInTimer = setTimeout(() => this.end(controller, { status: 'error', message: t().oauthExpired }), LOGIN_TIMEOUT_MS);
    void this.run(CONNECT_TEAMS, {
      signal: controller.signal,
      keepStdinOpen: true,
      onSpawn: (child) => {
        if (this.controller === controller) this.stdin = child.stdin ?? undefined;
      },
      onLine: (line) => {
        if (this.controller === controller) this.receive(controller, line);
      },
    }).then(
      (code) =>
        this.end(
          controller,
          code === 20 || code === 21 || code === 22
            ? dependency(code)
            : { status: 'error', message: code === 24 ? t().oauthExpired : t().oauthNoTeamsAccess },
        ),
      (err) => this.end(controller, this.failure(err)),
    );
    return this.view;
  }

  disconnect(): void {
    if (this.controller) this.end(this.controller);
    this.view = undefined;
  }

  private failure(err: unknown): TeamsConnection {
    return err instanceof CommandNotFoundError ? { status: 'missing-powershell' } : { status: 'error', message: t().teamsSetupFailed };
  }

  private end(controller: AbortController, view?: TeamsConnection): void {
    if (this.controller !== controller) return;
    this.controller = undefined;
    this.stdin = undefined;
    clearTimeout(this.signInTimer);
    clearTimeout(this.readTimer);
    this.view = view?.status === 'error' ? view : undefined;
    controller.abort();
    for (const request of this.pending.values())
      request.finish(undefined, new Error(view?.status === 'error' ? view.message : t().appsConnectFirst));
  }

  private receive(controller: AbortController, line: string): void {
    if (!line.startsWith('RELAY ')) {
      const clean = stripAnsi(line);
      // This is the text of DeviceCodeInfo.Message printed by Connect-MgGraph. Only the verification
      // code is transported to the browser. Its verification link is an app constant.
      const url = clean.match(/https:\/\/(?:login\.microsoft\.com\/device|(?:www\.)?microsoft\.com\/devicelogin)(?=\s|$)/i)?.[0];
      if (!url) return;
      const code = clean.match(/\b[A-Z0-9]{8,12}\b/)?.[0];
      if (code && this.view?.status === 'signing-in') this.view = { status: 'signing-in', code, url };
      else this.end(controller, { status: 'error', message: t().oauthNoTeamsAccess });
      return;
    }
    try {
      const event = JSON.parse(line.slice(6));
      if (typeof event.authError === 'string' && /^AADSTS\d{4,9}$/.test(event.authError)) {
        this.end(controller, { status: 'error', message: t().oauthNoTeamsAccess + ' (' + event.authError + ')' });
      } else if (typeof event.account === 'string' && this.view?.status === 'signing-in' && this.view.code && event.account.length <= 320) {
        clearTimeout(this.signInTimer);
        this.view = { status: 'connected', account: event.account };
      } else if (this.connected() && this.pending.has(event.id)) {
        const head = this.pending.keys().next().value === event.id;
        const pending = this.pending.get(event.id)!;
        if (typeof event.json === 'string') pending.finish(event.json);
        else
          pending.finish(
            undefined,
            new Error(
              event.error === 'size'
                ? t().appsTooLarge
                : t().teamsReadFailed +
                    (Number.isInteger(event.status) && event.status >= 400 && event.status <= 599 ? ' (HTTP ' + event.status + ')' : ''),
            ),
          );
        if (head) this.watchNextRead(controller);
      } else {
        this.end(controller, { status: 'error', message: t().oauthNoTeamsAccess });
      }
    } catch {
      this.end(controller, { status: 'error', message: t().teamsReadFailed });
    }
  }

  // PowerShell runs the piped GETs in order. Start each timeout when its GET reaches the front.
  private watchNextRead(controller: AbortController): void {
    clearTimeout(this.readTimer);
    if (this.pending.size)
      this.readTimer = setTimeout(() => this.end(controller, { status: 'error', message: t().nativeTimeout('Microsoft Graph') }), 30000);
  }

  // The private pipe carries JSON data, never PowerShell expressions. The SDK runs one request at a time.
  private async get<Row>(path: string): Promise<Row[]> {
    const controller = this.controller;
    const stdin = this.stdin;
    if (!this.connected() || !controller || !stdin?.writable) throw new Error(t().appsConnectFirst);
    if (this.pending.size >= 8) throw new Error(t().teamsReadFailed);
    const id = ++this.sequence;
    const json = await new Promise<string>((resolve, reject) => {
      this.pending.set(id, {
        finish: (value, error) => {
          this.pending.delete(id);
          if (error) reject(error);
          else resolve(value!);
        },
      });
      if (this.pending.size === 1) this.watchNextRead(controller);
      stdin.write(JSON.stringify({ id, uri: 'https://graph.microsoft.com/v1.0/' + path }) + '\n', (err) => {
        if (err) this.end(controller, { status: 'error', message: t().teamsReadFailed });
      });
    });
    const page = JSON.parse(json);
    if (!Array.isArray(page?.value)) throw new Error(t().teamsReadFailed);
    return page.value;
  }

  async list(team?: unknown): Promise<{ value: { id: string; displayName: string }[] }> {
    const rows = await this.get<{ id: string; displayName: string }>(
      team === undefined ? 'me/joinedTeams' : 'teams/' + segment(team) + '/channels?$select=id,displayName',
    );
    return { value: rows.map(({ id, displayName }) => ({ id, displayName })) };
  }

  async messages(team: unknown, channel: unknown): Promise<{ time: string; body: string; link?: string }[]> {
    const rows = await this.get<{ createdDateTime: string; body?: { content?: string }; webUrl?: string }>(
      'teams/' + segment(team) + '/channels/' + segment(channel) + '/messages?$top=20',
    );
    return rows.map((m) => ({ time: m.createdDateTime, body: m.body?.content ?? '', link: m.webUrl }));
  }
}
