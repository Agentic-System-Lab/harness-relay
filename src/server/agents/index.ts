import { isOpenProvider, type OpenProvider, type Provider } from '../../shared/types';
import { CliTooOldError, tooOld } from '../cliVersion';
import { antigravityRunner } from './antigravity';
import { claudeRunner } from './claude';
import { clineAgent } from './cline';
import { codexRunner } from './codex';
import { copilotRunner } from './copilot';
import { cursorRunner } from './cursor';
import { gooseAgent } from './goose';
import { grokRunner } from './grok';
import { museRunner } from './muse';
import { openHomeEnv, type OpenAgentDefinition } from './open';
import { opencodeAgent } from './opencode';
import { openhandsAgent } from './openhands';
import { piAgent } from './pi';
import { AgentRunError, type AgentRunner } from './types';

/** The open agents (OpenCode, Goose, Cline, OpenHands, Pi): each adapter's definition, from its own file. */
export const openAgents: Record<OpenProvider, OpenAgentDefinition> = {
  opencode: opencodeAgent,
  goose: gooseAgent,
  cline: clineAgent,
  openhands: openhandsAgent,
  pi: piAgent,
};

/** The environment a CLI's version is asked in (`--version`): an open agent's own home, not the user's. */
export function versionEnv(p: Provider, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return isOpenProvider(p) ? openHomeEnv(openAgents[p].process, env) : env;
}

/**
 * The runner `runner()` gives, refusing a run on a CLI older than Harness Relay supports (`tooOld()`)
 * before it starts: it would take what it is started with for a prompt (Codex 0.27 opens its terminal
 * UI and fails). The runner is looked up when a run starts: its module may still be loading when this
 * one is (an import cycle through `models.ts`).
 */
export function newEnoughOnly(provider: Provider, runner: () => AgentRunner): AgentRunner {
  return {
    provider,
    run: async (o) => {
      const old = await tooOld(provider, o.bin, versionEnv(provider, o.env));
      if (old) throw new AgentRunError(new CliTooOldError(provider, old).message);
      return runner().run(o);
    },
  };
}

export const runners: Record<Provider, AgentRunner> = {
  claude: newEnoughOnly('claude', () => claudeRunner),
  codex: newEnoughOnly('codex', () => codexRunner),
  grok: newEnoughOnly('grok', () => grokRunner),
  cursor: newEnoughOnly('cursor', () => cursorRunner),
  antigravity: newEnoughOnly('antigravity', () => antigravityRunner),
  copilot: newEnoughOnly('copilot', () => copilotRunner),
  muse: newEnoughOnly('muse', () => museRunner),
  opencode: newEnoughOnly('opencode', () => opencodeAgent.runner),
  goose: newEnoughOnly('goose', () => gooseAgent.runner),
  cline: newEnoughOnly('cline', () => clineAgent.runner),
  openhands: newEnoughOnly('openhands', () => openhandsAgent.runner),
  pi: newEnoughOnly('pi', () => piAgent.runner),
};

export * from './types';
