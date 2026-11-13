/**
 * Every CLI's facts (`clis/<provider>.ts`), by provider. Data only, so that `support/fake-cli.ts`,
 * which the desktop app's checks and `npm test` use too, can read it without Playwright.
 */
import type { Provider } from '../../../src/shared/types';
import { antigravity } from './antigravity';
import { claude } from './claude';
import { cline } from './cline';
import { codex } from './codex';
import { copilot } from './copilot';
import { cursor } from './cursor';
import { goose } from './goose';
import { grok } from './grok';
import { muse } from './muse';
import { opencode } from './opencode';
import { openhands } from './openhands';
import { pi } from './pi';
import type { CliFacts } from './types';

export type { CliFacts } from './types';

export const FACTS: Record<Provider, CliFacts> = { claude, codex, grok, cursor, antigravity, copilot, muse, opencode, goose, cline, openhands, pi };
