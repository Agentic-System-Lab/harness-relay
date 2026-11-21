import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse } from 'node:path';
import type { Writable } from 'node:stream';
import type { TeamsConnection } from '../../shared/types';
import { HttpError } from '../errors';
import { BREW_DIRS, findOnPath, isProgram } from '../executable';
import { t } from '../i18n';
import { LOGIN_TIMEOUT_MS } from '../login';
import { CommandNotFoundError, runProcess, stripAnsi, type SpawnOptions } from '../process';
import { CONNECT_TEAMS, INSTALL_TEAMS, POST_TEAMS, PROBE_TEAMS } from './teamsPowerShell';
import { installTeamsRuntime, publishTeamsDirectory, runtimeFolder, teamsModulesFolder, TeamsRuntimeError } from './teamsRuntime';

type Run = (
  script: string,
  options: Pick<SpawnOptions, 'signal' | 'timeoutMs' | 'onLine' | 'onSpawn' | 'keepStdinOpen'>,
) => Promise<number | null>;

function powerShellEnv() {
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
  return env;
}

const runPowerShell = async (script: string, options: Parameters<Run>[1], executable?: string): Promise<number | null> => {
  const env = powerShellEnv();
  const systemDirs =
    process.platform === 'win32'
      ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7')]
      : [...BREW_DIRS, '/usr/bin', '/usr/local/microsoft/powershell/7'];
  const portable = join(runtimeFolder(), process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
  const bin = executable ?? (isProgram(portable) ? portable : findOnPath('pwsh', env, process.platform, systemDirs, isProgram));
  if (!bin) throw new CommandNotFoundError('pwsh');
  if (script === INSTALL_TEAMS) {
    // An unloadable Graph module can leave incompatible assemblies in its process. Validate the existing
    // copy separately so the installer always verifies its freshly downloaded manifest in a clean shell.
    const existing = await runPowerShell(PROBE_TEAMS, { signal: options.signal, timeoutMs: 15000 }, bin);
    if (existing !== 21) return existing;
    options.signal?.throwIfAborted();
  }
  const modules = teamsModulesFolder();
  env.RELAY_TEAMS_MODULES = modules;
  // The SDK uses the .NET home for its account hint even when the token cache is process-scoped.
  const privateHome =
    (script === CONNECT_TEAMS || script === POST_TEAMS) && process.platform !== 'win32'
      ? await mkdtemp(join(tmpdir(), 'relay-teams-'))
      : undefined;
  if (process.platform !== 'win32') {
    env.RELAY_TEAMS_USER_MODULES = join(
      env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share'),
      'powershell',
      'Modules',
    );
    if (privateHome) env.HOME = privateHome;
  }
  let moduleTemp: string | undefined;
  try {
    if (script === INSTALL_TEAMS) {
      await mkdir(dirname(modules), { recursive: true, mode: 0o700 });
      moduleTemp = await mkdtemp(modules + '-install-');
      env.RELAY_TEAMS_MODULE_STAGE = join(moduleTemp, 'modules');
      await mkdir(env.RELAY_TEAMS_MODULE_STAGE, { mode: 0o700 });
    }
    const result = await runProcess({
      ...options,
      bin,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      env,
      cwd: parse(homedir()).root,
      maxCapture: 512,
    });
    if (result.timedOut) throw new Error(t().timedOut);
    const staged = env.RELAY_TEAMS_MODULE_STAGE;
    if (result.code === 0 && staged && existsSync(join(staged, 'Microsoft.Graph.Authentication'))) {
      await publishTeamsDirectory(staged, modules, options.signal!);
    }
    return result.code;
  } finally {
    if (moduleTemp) await rm(moduleTemp, { recursive: true, force: true, maxRetries: 3 });
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
class TeamsSession {
  tenantId?: string;
  private view?: TeamsConnection;
  private probe?: Promise<TeamsConnection>;
  private installation = 0;
  private controller?: AbortController;
  private stdin?: Writable;
  private signInTimer?: NodeJS.Timeout;
  private readTimer?: NodeJS.Timeout;
  private sequence = 0;
  private pending = new Map<number, Pending>();

  constructor(
    private run: Run,
    private postingFor?: { account: string; tenantId: string },
    private onClose?: () => void,
  ) {}

  current(): TeamsConnection | undefined {
    return this.view;
  }

  connected(): boolean {
    return this.view?.status === 'connected';
  }

  async status(): Promise<TeamsConnection> {
    if (this.view) return this.view;
    const installation = this.installation;
    const probe = (this.probe ??= this.run(PROBE_TEAMS, { timeoutMs: 15000 }).then(dependency, (err) => this.failure(err)));
    const available = await probe;
    if (probe === this.probe) this.probe = undefined;
    if (this.view) return this.view;
    return installation === this.installation ? available : this.status();
  }

  async install(installRuntime: (signal: AbortSignal) => Promise<void>): Promise<TeamsConnection> {
    if (this.controller && this.view) return this.view;
    // A diagnostic taken before this installation may finish after its dependency changes.
    this.installation++;
    this.probe = undefined;
    const controller = new AbortController();
    this.controller = controller;
    this.view = { status: 'installing' };
    const { signal } = controller;
    const module = () => this.run(INSTALL_TEAMS, { signal, timeoutMs: 180000 });
    const prepare = async () => {
      // The installer first probes the shell version and the existing Graph module.
      let result = await module().catch((err) => {
        if (err instanceof CommandNotFoundError) return 20;
        throw err;
      });
      if (result === 20) {
        signal.throwIfAborted();
        try {
          await installRuntime(signal);
        } catch (err) {
          if (err instanceof TeamsRuntimeError) throw err;
          throw new TeamsRuntimeError(t().teamsRuntimeRun);
        }
        signal.throwIfAborted();
        result = await module();
      }
      if (result !== 0) throw new Error(t().teamsSetupFailed);
      signal.throwIfAborted();
      if ((await this.run(PROBE_TEAMS, { signal, timeoutMs: 15000 })) !== 0) throw new Error(t().teamsSetupFailed);
    };
    void prepare().then(
      () => this.end(controller),
      (err) =>
        this.end(
          controller,
          signal.aborted
            ? undefined
            : {
                status: 'error',
                message: err instanceof TeamsRuntimeError ? err.message : t().teamsSetupFailed,
                retry: 'install',
              },
        ),
    );
    return this.view;
  }

  async connect(): Promise<TeamsConnection> {
    if (this.controller && this.view) return this.view;
    const controller = new AbortController();
    this.controller = controller;
    this.view = { status: 'signing-in' };
    this.signInTimer = setTimeout(() => this.end(controller, { status: 'error', message: t().oauthExpired }), LOGIN_TIMEOUT_MS);
    void this.run(this.postingFor ? POST_TEAMS : CONNECT_TEAMS, {
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
    if (this.view?.status === 'installing') {
      // Keep the installation slot until its child exits and its staging folder is cleaned up.
      this.controller?.abort();
      return;
    }
    if (this.controller) this.end(this.controller);
    this.view = undefined;
  }

  private failure(err: unknown): TeamsConnection {
    return err instanceof CommandNotFoundError ? { status: 'missing-powershell' } : { status: 'error', message: t().teamsSetupFailed };
  }

  private end(controller: AbortController, view?: TeamsConnection, cause?: Error): void {
    if (this.controller !== controller) return;
    this.controller = undefined;
    this.tenantId = undefined;
    this.onClose?.();
    this.stdin = undefined;
    clearTimeout(this.signInTimer);
    clearTimeout(this.readTimer);
    this.view = view?.status === 'error' ? view : undefined;
    controller.abort();
    for (const request of this.pending.values())
      request.finish(undefined, cause ?? new Error(view?.status === 'error' ? view.message : t().appsConnectFirst));
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
        this.tenantId = typeof event.tenantId === 'string' && GUID.test(event.tenantId) ? event.tenantId.toLowerCase() : undefined;
        if (
          this.postingFor &&
          (this.tenantId !== this.postingFor.tenantId || event.account.toLowerCase() !== this.postingFor.account.toLowerCase())
        ) {
          this.end(controller, { status: 'error', message: t().teamsPostingChanged });
          return;
        }
        clearTimeout(this.signInTimer);
        this.view = { status: 'connected', account: event.account };
      } else if (this.connected() && this.pending.has(event.id)) {
        if (event.error === 'graph' && event.status === 401) {
          const message = this.postingFor ? t().teamsPostingConnect : t().oauthNoTeamsAccess;
          this.end(controller, { status: 'error', message }, new HttpError(409, message));
          return;
        }
        const head = this.pending.keys().next().value === event.id;
        const pending = this.pending.get(event.id)!;
        if (event.error === 'graph' && event.status === 403) {
          pending.finish(undefined, new HttpError(403, t().teamsForbidden));
        } else if (typeof event.json === 'string') pending.finish(event.json);
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
  async request<Result>(path: string, text?: string): Promise<Result> {
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
      stdin.write(JSON.stringify({ id, uri: 'https://graph.microsoft.com/v1.0/' + path, text }) + '\n', (err) => {
        if (err) this.end(controller, { status: 'error', message: t().teamsReadFailed });
      });
    });
    return JSON.parse(json);
  }
}

const GUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const THREAD = /^19:[A-Za-z0-9_.:-]+@[A-Za-z0-9.-]+$/;
type Destination = { kind: 'channel'; teamId: string; destinationId: string } | { kind: 'chat'; teamId?: undefined; destinationId: string };

export type TeamsPostTarget = Destination & { tenantId: string; senderId: string; sender: string; destination: string };

function destinationFromLink(link: string, tenantId: string): Destination {
  const invalid = () => new Error(t().teamsPostingTarget);
  if (typeof link !== 'string' || link.length > 8192) throw invalid();
  let url: URL;
  let parts: string[];
  try {
    url = new URL(link);
    parts = url.pathname.split('/').map(decodeURIComponent);
  } catch {
    throw invalid();
  }
  if (url.origin !== 'https://teams.microsoft.com' || url.username || url.password || parts.length !== 5 || parts[1] !== 'l')
    throw invalid();
  const [, , type, destinationId, item] = parts;
  if (
    !THREAD.test(destinationId) ||
    destinationId.length > 300 ||
    !item ||
    url.searchParams.getAll('tenantId').length > 1 ||
    url.searchParams.getAll('groupId').length > 1
  )
    throw invalid();
  const tenant = url.searchParams.get('tenantId');
  if (tenant !== null && tenant.toLowerCase() !== tenantId) throw invalid();
  const teamId = url.searchParams.get('groupId');
  if (type === 'message' && !/^\d+$/.test(item)) throw invalid();
  if (type === 'channel' || (type === 'message' && teamId !== null)) {
    if (!teamId || !GUID.test(teamId)) throw invalid();
    return { kind: 'channel', teamId: teamId.toLowerCase(), destinationId };
  }
  if (
    teamId !== null ||
    /@thread\.tacv2$/i.test(destinationId) ||
    !(type === 'message' || (type === 'chat' && ['conversations', '0'].includes(item)))
  )
    throw invalid();
  return { kind: 'chat', destinationId };
}

function cleanLabel(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .trim()
        .slice(0, 220)
    : '';
}

/** Reading and posting have separate device codes and separate Graph processes. Cancelling either never starts another sign-in. */
export class TeamsGraph {
  private read: TeamsSession;
  private writer?: TeamsSession;

  constructor(
    private run: Run = runPowerShell,
    private installRuntime: (signal: AbortSignal) => Promise<void> = (signal) =>
      installTeamsRuntime(signal, (exe) => runPowerShell(PROBE_TEAMS, { signal, timeoutMs: 15000 }, exe), powerShellEnv()),
  ) {
    this.read = new TeamsSession(run, undefined, () => this.disconnectPosting());
  }

  connected(): boolean {
    return this.read.connected();
  }
  canPost(): boolean {
    return this.connected() && !!this.writer?.connected();
  }
  install(): Promise<TeamsConnection> {
    return this.read.install(this.installRuntime);
  }
  async connect(): Promise<TeamsConnection> {
    await this.read.connect();
    return this.status();
  }
  disconnect(): void {
    this.read.disconnect();
    this.disconnectPosting();
  }

  async status(): Promise<TeamsConnection> {
    const state = await this.read.status();
    if (state.status !== 'connected' || !this.writer) return state;
    const posting = this.writer.current();
    if (posting?.status === 'connected') return { ...state, canPost: true };
    if (posting?.status === 'signing-in' || posting?.status === 'error') return { ...state, posting };
    return state;
  }

  async connectPosting(): Promise<TeamsConnection> {
    const state = this.read.current();
    if (state?.status !== 'connected' || !this.read.tenantId) throw new HttpError(409, t().appsConnectFirst);
    this.writer ??= new TeamsSession(this.run, { account: state.account, tenantId: this.read.tenantId });
    await this.writer.connect();
    return this.status();
  }

  disconnectPosting(): void {
    this.writer?.disconnect();
    this.writer = undefined;
  }

  private async get<Row>(path: string): Promise<Row[]> {
    const page = await this.read.request<{ value: Row[] }>(path);
    if (!Array.isArray(page?.value)) throw new Error(t().teamsReadFailed);
    return page.value;
  }

  private posting(): TeamsSession {
    if (!this.writer?.connected() || !this.read.connected()) throw new Error(t().teamsPostingConnect);
    return this.writer;
  }

  private async resolveTarget(session: TeamsSession, destination: Destination): Promise<TeamsPostTarget> {
    const tenantId = session.tenantId;
    const state = session.current();
    if (!tenantId || state?.status !== 'connected') throw new Error(t().teamsPostingConnect);
    const me = await session.request<{ id: string }>('me?$select=id');
    if (typeof me?.id !== 'string' || !GUID.test(me.id)) throw new Error(t().teamsPostingChanged);
    const identity = { tenantId, senderId: me.id.toLowerCase(), sender: state.account };
    const id = segment(destination.destinationId);
    if (destination.kind === 'channel') {
      if (!GUID.test(destination.teamId)) throw new Error(t().teamsPostingTarget);
      const teamRoute = 'teams/' + segment(destination.teamId);
      const [team, channel] = await Promise.all([
        session.request<{ id: string; displayName: string; tenantId: string }>(teamRoute + '?$select=id,displayName,tenantId'),
        session.request<{ id: string; displayName: string; tenantId: string }>(
          teamRoute + '/channels/' + id + '?$select=id,displayName,tenantId',
        ),
      ]);
      if (
        team?.id?.toLowerCase() !== destination.teamId ||
        channel?.id !== destination.destinationId ||
        team.tenantId?.toLowerCase() !== tenantId ||
        channel.tenantId?.toLowerCase() !== tenantId ||
        !cleanLabel(team.displayName) ||
        !cleanLabel(channel.displayName)
      )
        throw new Error(t().teamsPostingTarget);
      return { ...destination, ...identity, destination: cleanLabel(team.displayName) + ' / ' + cleanLabel(channel.displayName) };
    }
    const chat = await session.request<{
      id: string;
      tenantId: string;
      topic?: string;
      members?: { displayName?: string; email?: string }[];
    }>('chats/' + id + '?$expand=members');
    if (chat?.id !== destination.destinationId || chat.tenantId?.toLowerCase() !== tenantId) throw new Error(t().teamsPostingTarget);
    const names =
      chat.members
        ?.slice(0, 5)
        .map((m) => cleanLabel(m.email) || cleanLabel(m.displayName))
        .filter(Boolean) ?? [];
    const label = cleanLabel(chat.topic) || (names.length ? names.join(', ') + ((chat.members?.length ?? 0) > 5 ? ' …' : '') : '');
    if (!label) throw new Error(t().teamsPostingTarget);
    return { ...destination, ...identity, destination: label };
  }

  async resolvePost(link: string): Promise<TeamsPostTarget> {
    const writer = this.posting();
    return this.resolveTarget(writer, destinationFromLink(link, writer.tenantId!));
  }

  /** Only the outbox calls this, after the user confirms. Re-read the exact sender and destination before issuing a single POST. */
  async sendPost(target: TeamsPostTarget, text: string): Promise<void> {
    const writer = this.posting();
    if (!target || target.tenantId !== writer.tenantId || !THREAD.test(target.destinationId) || !['channel', 'chat'].includes(target.kind))
      throw new Error(t().teamsPostingChanged);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 28 * 1024) throw new Error(t().invalidField('text'));
    const now = await this.resolveTarget(writer, target);
    if (
      writer !== this.posting() ||
      now.senderId !== target.senderId ||
      now.sender !== target.sender ||
      now.destination !== target.destination
    )
      throw new Error(t().teamsPostingChanged);
    const id = segment(target.destinationId);
    const path = target.kind === 'channel' ? 'teams/' + segment(target.teamId) + '/channels/' + id : 'chats/' + id;
    try {
      const posted = await writer.request<{ id: string }>(path + '/messages', text);
      if (!posted?.id) throw new Error();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // A network error can occur after Graph accepted the message.
      throw new Error(t().teamsPostFailed);
    }
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
