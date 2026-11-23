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
 * GitHub's tokens (`GH_TOKEN`, `GITHUB_TOKEN`) and the cloud's (`AWS_*`) stay, since agents' git, gh
 * and cloud tools use them. The open agents are not concerned: they get no key of the server's at all
 * (`INHERITED_BACKEND_VARS`), only their run's backend's.
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
 * its own sign-in by key (`CREDENTIAL_ENV`); Claude Code's Amazon Bedrock key too; Antigravity's
 * Google API key (Vertex AI's express mode), beside its Gemini one; Copilot's key for a model provider
 * of the user's (BYOK). Codex also keeps the keys its `config.toml` names (`codexConfigKeys()`).
 */
export const OWN_KEY_VARS: Record<SignInProvider, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  grok: ['XAI_API_KEY'],
  cursor: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'],
  antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'],
  muse: ['META_API_KEY'],
};

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

/** `codexConfigKeys()` of the `config.toml` in a Codex home: none when it cannot be read or is larger than `CODEX_CONFIG_MAX`. */
export function codexHomeKeys(home: string): string[] {
  const file = join(home, 'config.toml');
  try {
    if (statSync(file).size > CODEX_CONFIG_MAX) return [];
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
