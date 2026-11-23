import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_NAME_RE, MAX_PASS_ENV } from '../shared/agentEnv';
import { isOpenProvider, type OpenProvider, type Provider } from '../shared/types';

export { ENV_NAME_RE, MAX_PASS_ENV };

/*
 * The model providers' keys of the server's environment that each CLI with a sign-in of its own is
 * given (Settings → its card → Environment variables). The server copies its environment into every
 * CLI it starts (`SettingsStore.env()`), so a key exported in the shell that started Harness Relay
 * reached every CLI, and every command and MCP server that CLI starts: Claude Code's runs had the
 * shell's OpenAI and xAI keys, Codex's its Anthropic key. Now each CLI keeps only the keys it signs in
 * or reaches its models with (`OWN_KEY_VARS`; Codex also those its `config.toml` names), and the
 * others are withheld unless the user passes them on for that CLI (`SettingsStore.passEnv()`).
 * Only keys and tokens are withheld: addresses (base URLs, a host, a project) are not secrets, and
 * GitHub's tokens (`GH_TOKEN`, `GITHUB_TOKEN`) and the cloud's (`AWS_*`, but Amazon Bedrock's API key,
 * `AWS_BEARER_TOKEN_BEDROCK`, which is Claude Code's) stay, since agents' git, gh and cloud tools use
 * them. The open agents are not concerned: they get no key of the server's at all
 * (`INHERITED_BACKEND_VARS`), only their run's backend's.
 *
 * This keeps the keys out of the environment a CLI's commands inherit, so that a tool which picks a
 * key up by itself does not find one; it is no wall. The server's own process still holds them all
 * (changing `process.env` does not change what the system shows of it), and a command of the same
 * user that can see that process reads them there (`/proc/<pid>/environ` on Linux, `ps -E` on macOS):
 * with full access, outside a sandbox, or in one that does not hide other processes.
 */

/**
 * The model providers' keys and tokens a CLI may find in the server's environment: those of the model
 * APIs the CLIs and the user's projects know (`INHERITED_BACKEND_VARS` without its addresses), and each
 * CLI's own sign-in by key or token (`CREDENTIAL_ENV` without GitHub's tokens). Withheld from a CLI
 * whose own they are not (`withheldEnv()`).
 */
export const MODEL_KEY_VARS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'VERTEX_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'TOGETHERAI_API_KEY',
  'FIREWORKS_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  'COHERE_API_KEY',
  'CO_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'HUGGING_FACE_HUB_TOKEN',
  'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY',
  'NVIDIA_API_KEY',
  'REPLICATE_API_TOKEN',
  'VOYAGE_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'ZAI_API_KEY',
  'LITELLM_API_KEY',
  'OLLAMA_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'META_API_KEY',
] as const;

/**
 * The variables of `INHERITED_BACKEND_VARS` that are not keys: addresses, a project, a key file's path,
 * a sign-in's kind. No CLI's runs lose these.
 */
export const MODEL_ADDRESS_VARS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'XAI_BASE_URL',
  'XAI_API_BASE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENROUTER_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_API_BASE',
  'OLLAMA_HOST',
  'AGY_ADC_AUTH',
  'COPILOT_PROVIDER_BASE_URL',
] as const;

/** The CLIs with a sign-in of their own: the ones whose runs are given keys of the server's environment. */
export type SignInProvider = Exclude<Provider, OpenProvider>;

/**
 * The keys of `MODEL_KEY_VARS` each CLI signs in or reaches its models with, which its runs keep:
 * its own sign-in by key (`CREDENTIAL_ENV`); Claude Code's Amazon Bedrock key too; Copilot's key for a
 * model provider of the user's (BYOK). Antigravity runs on its Gemini API key alone (`GOOGLE_API_KEY`
 * does not change the key agy uses, `antigravityOtherSignIn()`). Codex also keeps the keys its
 * `config.toml` names (`codexConfigKeys()`).
 */
export const OWN_KEY_VARS: Record<SignInProvider, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  grok: ['XAI_API_KEY'],
  cursor: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'],
  antigravity: ['GEMINI_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'],
  muse: ['META_API_KEY'],
};

/**
 * Where each CLI with a sign-in takes it from in the server's environment, the first one set winning
 * (`envSignIn()`): Claude Code's cloud providers before any key (its own docs, and `claudeEndpointEnv()`),
 * then `ANTHROPIC_AUTH_TOKEN` before `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`; Copilot's
 * `COPILOT_GITHUB_TOKEN` before `GH_TOKEN` and `GITHUB_TOKEN`; the others as `CREDENTIAL_ENV` lists them.
 */
export const SIGN_IN_ORDER: Record<SignInProvider, readonly string[]> = {
  claude: [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  grok: ['XAI_API_KEY'],
  cursor: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'],
  antigravity: ['GEMINI_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  muse: ['META_API_KEY'],
};

/** Claude Code's switches to a cloud provider, which count only when on (`1`, `true`), not `0`. */
const SWITCHES = new Set(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);

/**
 * The variable of `env` a CLI's default account signs in with, ahead of the sign-in kept in its home:
 * the first one set in `SIGN_IN_ORDER`. `stored` is the variable an API key Settings keeps for the
 * account goes in: once the order reaches it, the account runs on that key, and nothing of `env` is
 * named. Undefined for an open agent, or when nothing of `env` signs it in.
 */
export function envSignIn(p: Provider, env: NodeJS.ProcessEnv, stored?: string): string | undefined {
  if (isOpenProvider(p)) return undefined;
  for (const k of SIGN_IN_ORDER[p]) {
    if (k === stored) return undefined;
    const v = env[k]?.trim();
    if (v && !(SWITCHES.has(k) && /^(0|false|no|off)$/i.test(v))) return k;
  }
  return undefined;
}

/** The most of Codex's `config.toml` read for the keys it names; a larger file is not read. */
const CODEX_CONFIG_MAX = 1024 * 1024;

/** Codex's home for an account: the one Harness Relay gives it, else `CODEX_HOME`, else `~/.codex`. */
export function codexHomeFor(accountHome: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return accountHome || env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/**
 * The keys a Codex `config.toml` names for its model providers (`env_key = "NAME"`, in a table or an
 * inline one), which Codex's runs keep. Comment lines are skipped.
 */
export function codexConfigKeys(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    for (const m of line.matchAll(/\benv_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) names.add(m[1]!);
  }
  return [...names];
}

/**
 * `codexConfigKeys()` of the `config.toml` in a Codex home: none when it cannot be read, is not a
 * plain file (a FIFO, or a link to a device, would hold the server up: it runs on every CLI start) or
 * is larger than `CODEX_CONFIG_MAX`.
 */
export function codexHomeKeys(home: string): string[] {
  const file = join(home, 'config.toml');
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > CODEX_CONFIG_MAX) return [];
    return codexConfigKeys(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** The keys a CLI's runs keep: `OWN_KEY_VARS`, and for Codex those its configuration names (`codexKeys`). */
export function ownKeyVars(p: SignInProvider, codexKeys: readonly string[] = []): Set<string> {
  return new Set([...OWN_KEY_VARS[p], ...(p === 'codex' ? codexKeys : [])]);
}

/**
 * The keys of `MODEL_KEY_VARS` set (not empty) in `env` that a CLI's runs are not given: those that
 * are not its own (`ownKeyVars()`) and that the user does not pass on to it (`pass`). In the order of
 * `MODEL_KEY_VARS`. None for an open agent, whose environment is its backend's alone.
 */
export function withheldEnv(
  p: Provider,
  env: NodeJS.ProcessEnv,
  o: { pass?: readonly string[]; codexKeys?: readonly string[] } = {},
): string[] {
  if (isOpenProvider(p)) return [];
  const own = ownKeyVars(p, o.codexKeys);
  const pass = new Set(o.pass ?? []);
  return MODEL_KEY_VARS.filter((k) => Boolean(env[k]) && !own.has(k) && !pass.has(k));
}

/**
 * A pass-through list as it is kept: each name trimmed, valid (`ENV_NAME_RE`), once, in the order
 * given, at most `MAX_PASS_ENV`. Undefined when the input is not such a list (`bad` says which name).
 */
export function passEnvList(input: unknown): { names: string[] } | { bad: string } | { tooMany: true } | undefined {
  if (!Array.isArray(input)) return undefined;
  const names: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') return undefined;
    const name = v.trim();
    if (!ENV_NAME_RE.test(name)) return { bad: name };
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > MAX_PASS_ENV) return { tooMany: true };
  return { names };
}
