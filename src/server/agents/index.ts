import type { OpenProvider, Provider } from '../../shared/types';
import { claudeRunner } from './claude';
import { clineAgent } from './cline';
import { codexRunner } from './codex';
import { gooseAgent } from './goose';
import { grokRunner } from './grok';
import type { OpenAgentDefinition } from './open';
import { opencodeAgent } from './opencode';
import { openhandsAgent } from './openhands';
import { piAgent } from './pi';
import type { AgentRunner } from './types';

/** The open agents (OpenCode, Goose, Cline, OpenHands, Pi): each adapter's definition, from its own file. */
export const openAgents: Record<OpenProvider, OpenAgentDefinition> = {
  opencode: opencodeAgent,
  goose: gooseAgent,
  cline: clineAgent,
  openhands: openhandsAgent,
  pi: piAgent,
};

export const runners: Record<Provider, AgentRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
  grok: grokRunner,
  opencode: opencodeAgent.runner,
  goose: gooseAgent.runner,
  cline: clineAgent.runner,
  openhands: openhandsAgent.runner,
  pi: piAgent.runner,
};

export * from './types';
