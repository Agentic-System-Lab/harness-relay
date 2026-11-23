import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_LIMITS, parseBackendModel, parseCliSubModel, SUB_MODEL_CLIS, type MailServer, type ServerLimits } from '../shared/types';

/**
 * What the server's environment sets at startup besides its port, host and data folder
 * (`settings.ts`): limits that the UI keeps to as well (`GET /api/limits`), each agent turn's safety
 * timeout, and where voice input downloads its engine and models from and keeps them. Read once, when
 * the server starts; `index.ts` refuses to start on a value that is not valid (`CONFIG_PROBLEMS`)
 * rather than run with another one than the user meant.
 */
export interface ServerConfig extends ServerLimits {
  turnTimeoutMs: number;
  previewDomain?: string;
  /** The folder the voice models are in (`<base>/<file>`); undefined = Hugging Face, pinned to one commit. */
  voiceModelBaseUrl?: string;
  /** The folder the voice engine's archives are in (`<base>/<asset>`); undefined = whisper.cpp's release on GitHub. */
  voiceEngineBaseUrl?: string;
  /** Where voice input keeps its models and engine; undefined = `voice` in the data folder. */
  voiceDir?: string;
  /**
   * The Chromium, Chrome or Edge the browser tools start (`RELAY_BROWSER`), unless Settings sets one; undefined =
   * the first one found (`browser/find.ts`).
   */
  browser?: string;
  /**
   * Where accounts that sign in with Microsoft do (`RELAY_MICROSOFT_LOGIN_URL`) and their calendars are
   * reached (`RELAY_MICROSOFT_GRAPH_URL`): another cloud than Microsoft's global one (a national one,
   * `https://login.microsoftonline.us` and `https://graph.microsoft.us`, say), or a stand-in on this
   * computer in the end-to-end tests. undefined = `https://login.microsoftonline.com` and
   * `https://graph.microsoft.com`.
   */
  microsoftLoginUrl?: string;
  microsoftGraphUrl?: string;
  /**
   * The mail servers an account that signs in with Microsoft is reached at for the mail tools
   * (`RELAY_MICROSOFT_IMAP`, `RELAY_MICROSOFT_SMTP`, as `host:port`): a stand-in on this computer in
   * the end-to-end tests, the only place plain TCP goes to. Not for a national cloud: its mail is not
   * supported yet, as the token for mail is asked for the global cloud's Exchange Online
   * (`https://outlook.office.com/…`), which another cloud's servers do not take. undefined =
   * `outlook.office365.com:993` (TLS) and `smtp.office365.com:587` (STARTTLS).
   */
  microsoftImap?: MailServer;
  microsoftSmtp?: MailServer;
  /**
   * Settings → Labs' mode until it is changed there (`SettingsStore.labs()`): whether agents get the
   * gateway's `run_code` tool (`RELAY_RUN_CODE=on`): JavaScript that calls the turn's other Harness Relay
   * tools as functions, run in Harness Relay's own sandbox with no network (`runCode.ts`). Off by
   * default: agents call those tools one at a time, as before.
   */
  runCode: boolean;
  /**
   * Whether the lead agent names new conversations after their first message, until it is changed in
   * Settings (`SettingsStore.chatTitles`): on unless `RELAY_CHAT_TITLES=off`.
   */
  chatTitles: boolean;
  /**
   * RLM mode (`RELAY_RLM=<backend>/<model>`, a model connection of Settings), as Labs' mode until it is
   * changed there: `run_code` keeps a `state` for the rest of the agent's turn and gives the code
   * `llm_query()`, a question to this sub-model, which the server asks with no tools (`llmQuery.ts`). It
   * turns `run_code` on. undefined = off.
   */
  rlmModel?: string;
  /**
   * Stand-ins on this computer for publishing a previewed app, in the end-to-end tests only: Render's
   * API (`RELAY_RENDER_API_URL`), Neon's (`RELAY_NEON_API_URL`) and a folder of bare repositories in
   * GitHub's place (`RELAY_PUBLISH_GIT_DIR`, `<folder>/<owner>/<name>.git`). undefined =
   * `https://api.render.com/v1`, `https://console.neon.tech/api/v2` and `https://github.com`.
   */
  renderApiUrl?: string;
  neonApiUrl?: string;
  publishGitDir?: string;
  /**
   * A stand-in, in the end-to-end tests only, for a computer that shows windows (`RELAY_HEADLESS_WINDOWS=on`):
   * a hand-over's window can open wherever the server runs, and opens
   * headless, so that a test runs them without a display. false = where this computer can show one, for real.
   */
  headlessWindows: boolean;
}

/**
 * The whole numbers each limit may be set to: from one, and below a value no setup needs, to catch a typo.
 * The turn timeout goes up to 7 days, well below the 24.8 days a timer can wait (`setTimeout`).
 */
const RANGES = {
  RELAY_MAX_ACCOUNTS: [1, 100],
  RELAY_MAX_TEAM_AGENTS: [1, 32],
  RELAY_TURN_TIMEOUT_MIN: [1, 7 * 24 * 60],
} as const;

/** The configuration `env` sets, and what in it is not valid (each such value left at its default). */
export function readConfig(env: NodeJS.ProcessEnv = process.env): { config: ServerConfig; problems: string[] } {
  const problems: string[] = [];

  const whole = (name: keyof typeof RANGES, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const [min, max] = RANGES[name];
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isSafeInteger(n) && n >= min && n <= max) return n;
    problems.push(`${name}=${raw} is not a whole number from ${min} to ${max}.`);
    return fallback;
  };

  // The files are checked against their pinned size and SHA-256 wherever they come from, so a mirror
  // can serve them but not change them; plain http is fine for that reason (an office's own server).
  const base = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      // Not repeated: it may hold a password all the same, and this goes to the log.
      problems.push(`${name} is not a URL.`);
      return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`${name} must be an http or https URL, not ${url.protocol}.`);
      return undefined;
    }
    // The address shows in Settings' install log; fetch refuses one with a password anyway.
    if (url.username || url.password) {
      problems.push(`${name} must not hold a user name or password.`);
      return undefined;
    }
    if (url.search || url.hash) {
      problems.push(`${name} must be a folder's address, without ? or #.`);
      return undefined;
    }
    return url.href.replace(/\/+$/, '');
  };

  // An absolute path, or one from the home folder (`~`): the desktop app starts the server in a folder
  // of its own, so a relative one would not be where the user meant.
  const folder = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const path = raw === '~' ? homedir() : /^~[\\/]/.test(raw) ? join(homedir(), raw.slice(2)) : raw;
    if (isAbsolute(path)) return resolve(path);
    problems.push(`${name}=${raw} is not an absolute path (or one starting with ~/).`);
    return undefined;
  };

  // Tokens go there: https, or plain http to this computer only (a stand-in).
  const secure = (name: string): string | undefined => {
    const url = base(name);
    if (!url) return undefined;
    const { protocol, hostname } = new URL(url);
    if (protocol === 'https:' || /^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostname)) return url;
    problems.push(`${name} must be an https URL (plain http only to this computer).`);
    return undefined;
  };

  // A stand-in on this computer, and nothing else: an API a key goes to that is not the host's own.
  const local = (name: string): string | undefined => {
    const url = base(name);
    if (!url) return undefined;
    if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(url).hostname)) return url;
    problems.push(`${name} must be a stand-in's URL on this computer (127.0.0.1, localhost or [::1]).`);
    return undefined;
  };

  // A mail server a token goes to, as `host:port`: TLS, or STARTTLS on the port that asks for it
  // (IMAP's 143, SMTP's 587 and 25); plain TCP to this computer only (a stand-in).
  const mailServer = (name: string, kind: 'imap' | 'smtp'): MailServer | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const m = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(raw);
    const port = m ? Number(m[2]) : NaN;
    if (!m || port < 1 || port > 65535) {
      problems.push(`${name} must be a mail server's host:port.`);
      return undefined;
    }
    const host = m[1]!.replace(/^\[|\]$/g, '').toLowerCase();
    if (/^(127\.0\.0\.1|localhost|::1)$/.test(host)) return { host, port, security: 'none' };
    const starttls = kind === 'imap' ? port === 143 : port === 587 || port === 25;
    return { host, port, security: starttls ? 'starttls' : 'tls' };
  };

  // `on` or `off` (any letter case); unset or blank is off. Anything else is refused rather than read as either.
  const onOff = (name: string): boolean => {
    const raw = env[name]?.trim();
    if (!raw || raw.toLowerCase() === 'off') return false;
    if (raw.toLowerCase() === 'on') return true;
    problems.push(`${name}=${raw} is neither on nor off.`);
    return false;
  };

  // RLM mode: off, or the sub-model as `<backend>/<model>`, or through a CLI as
  // `cli:<provider>[:<account>][/<model>]`. Whether that connection or account is set up is found out
  // when the code asks it (Settings can change it meanwhile).
  const rlm = (): string | undefined => {
    const raw = env.RELAY_RLM?.trim();
    if (!raw || raw.toLowerCase() === 'off') return undefined;
    if (parseBackendModel(raw) || parseCliSubModel(raw)) return raw;
    problems.push(
      `RELAY_RLM=${raw} must be off, or the sub-model as <backend>/<model> (a model connection in Settings), such as anthropic/claude-haiku-5-5, or through ${SUB_MODEL_CLIS.join(', ')} as cli:<provider>[:<account>][/<model>], such as cli:claude/haiku.`,
    );
    return undefined;
  };
  const rlmModel = rlm();
  const runCode = onOff('RELAY_RUN_CODE');
  // On unless set to off.
  const chatTitles = env.RELAY_CHAT_TITLES?.trim() ? onOff('RELAY_CHAT_TITLES') : true;
  if (rlmModel && env.RELAY_RUN_CODE?.trim().toLowerCase() === 'off')
    problems.push('RELAY_RLM needs run_code: leave RELAY_RUN_CODE unset, or set it to on.');

  const turnTimeoutMinutes = whole('RELAY_TURN_TIMEOUT_MIN', DEFAULT_LIMITS.turnTimeoutMinutes);
  const previewDomain = env.RELAY_PREVIEW_DOMAIN?.trim().toLowerCase();
  if (
    previewDomain &&
    (previewDomain.length > 240 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(previewDomain) ||
      previewDomain.endsWith('.localhost'))
  )
    problems.push('RELAY_PREVIEW_DOMAIN must be a DNS domain for the dedicated HTTPS preview hosts.');

  const config: ServerConfig = {
    ...(previewDomain ? { previewDomain } : {}),
    maxAccounts: whole('RELAY_MAX_ACCOUNTS', DEFAULT_LIMITS.maxAccounts),
    maxTeamAgents: whole('RELAY_MAX_TEAM_AGENTS', DEFAULT_LIMITS.maxTeamAgents),
    turnTimeoutMinutes,
    turnTimeoutMs: turnTimeoutMinutes * 60_000,
    voiceModelBaseUrl: base('RELAY_VOICE_MODEL_BASE_URL'),
    voiceEngineBaseUrl: base('RELAY_VOICE_ENGINE_BASE_URL'),
    voiceDir: folder('RELAY_VOICE_DIR'),
    browser: folder('RELAY_BROWSER'),
    microsoftLoginUrl: secure('RELAY_MICROSOFT_LOGIN_URL'),
    microsoftGraphUrl: secure('RELAY_MICROSOFT_GRAPH_URL'),
    microsoftImap: mailServer('RELAY_MICROSOFT_IMAP', 'imap'),
    microsoftSmtp: mailServer('RELAY_MICROSOFT_SMTP', 'smtp'),
    runCode: runCode || Boolean(rlmModel),
    chatTitles,
    ...(rlmModel ? { rlmModel } : {}),
    renderApiUrl: local('RELAY_RENDER_API_URL'),
    neonApiUrl: local('RELAY_NEON_API_URL'),
    publishGitDir: folder('RELAY_PUBLISH_GIT_DIR'),
    headlessWindows: onOff('RELAY_HEADLESS_WINDOWS'),
  };
  return { config, problems };
}

/** The limits of a configuration, as `GET /api/limits` gives them. */
export function limitsOf(c: ServerLimits): ServerLimits {
  return { maxAccounts: c.maxAccounts, maxTeamAgents: c.maxTeamAgents, turnTimeoutMinutes: c.turnTimeoutMinutes };
}

const read = readConfig();
/** This server's configuration, from its environment at startup. */
export const CONFIG: ServerConfig = read.config;
/** What in this server's environment is not valid; the server does not start while there is any. */
export const CONFIG_PROBLEMS: readonly string[] = read.problems;
