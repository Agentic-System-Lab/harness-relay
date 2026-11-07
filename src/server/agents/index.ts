import type { Provider } from '../../shared/types';
import { claudeRunner } from './claude';
import { codexRunner } from './codex';
import { grokRunner } from './grok';
import type { AgentRunner } from './types';

export const runners: Record<Provider, AgentRunner> = {
  claude: claudeRunner,
  codex: codexRunner,
  grok: grokRunner,
};

export * from './types';
