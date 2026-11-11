import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_LIMITS, type ServerLimits } from '../shared/types';

/**
 * What the server's environment sets at startup besides its port, host and data folder
 * (`settings.ts`): limits that the UI keeps to as well (`GET /api/limits`), each agent turn's safety
 * timeout, and where voice input downloads its engine and models from and keeps them. Read once, when
 * the server starts; `index.ts` refuses to start on a value that is not valid (`CONFIG_PROBLEMS`)
 * rather than run with another one than the user meant.
 */
export interface ServerConfig extends ServerLimits {
  turnTimeoutMs: number;
  /** The folder the voice models are in (`<base>/<file>`); undefined = Hugging Face, pinned to one commit. */
  voiceModelBaseUrl?: string;
  /** The folder the voice engine's archives are in (`<base>/<asset>`); undefined = whisper.cpp's release on GitHub. */
  voiceEngineBaseUrl?: string;
  /** Where voice input keeps its models and engine; undefined = `voice` in the data folder. */
  voiceDir?: string;
}

/** The whole numbers each limit may be set to: from one, and below a value no setup needs, to catch a typo. */
const RANGES = {
  RELAY_MAX_ACCOUNTS: [1, 100],
  RELAY_MAX_TEAM_AGENTS: [1, 32],
  RELAY_TURN_TIMEOUT_MIN: [1, 24 * 60],
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

  const turnTimeoutMinutes = whole('RELAY_TURN_TIMEOUT_MIN', DEFAULT_LIMITS.turnTimeoutMinutes);
  const config: ServerConfig = {
    maxAccounts: whole('RELAY_MAX_ACCOUNTS', DEFAULT_LIMITS.maxAccounts),
    maxTeamAgents: whole('RELAY_MAX_TEAM_AGENTS', DEFAULT_LIMITS.maxTeamAgents),
    turnTimeoutMinutes,
    turnTimeoutMs: turnTimeoutMinutes * 60_000,
    voiceModelBaseUrl: base('RELAY_VOICE_MODEL_BASE_URL'),
    voiceEngineBaseUrl: base('RELAY_VOICE_ENGINE_BASE_URL'),
    voiceDir: folder('RELAY_VOICE_DIR'),
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
