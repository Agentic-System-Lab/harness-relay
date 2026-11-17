import { describe, expect, it } from 'vitest';
import type { SandboxSetupView } from '../src/shared/types';
import { askOnNewChat, byHand, canInstall, readAsked, setupRunning, usersText, writeAsked } from '../src/web/sandboxSetup';

const packages = {
  kind: 'packages' as const,
  items: ['bubblewrap', 'socat'],
  for: ['claude' as const, 'open' as const],
  command: 'sudo apt-get install -y bubblewrap socat',
};
const job = (state: 'running' | 'success' | 'failed' | 'cancelled') => ({ state, startedAt: 1, log: '' });

describe('the sandboxes’ setup on the page', () => {
  it('opens the dialog on New chat while something is missing, no install runs, and this browser was not asked', () => {
    const view: SandboxSetupView = { platform: 'linux', needs: [packages], admin: 'sudo' };
    expect(askOnNewChat(view, false)).toBe(true);
    expect(askOnNewChat(view, true)).toBe(false);
    expect(askOnNewChat({ platform: 'linux', needs: [] }, false)).toBe(false);
    expect(askOnNewChat(undefined, false)).toBe(false);
    expect(askOnNewChat({ ...view, job: job('running') }, false)).toBe(false);
    // Missing, but nothing of it can be installed here: still asked, with what to run by hand.
    expect(askOnNewChat({ platform: 'linux', needs: [{ ...packages, blocked: 'admin' }] }, false)).toBe(true);
  });

  it('offers Install only for what can be installed here, and says what to run by hand for the rest', () => {
    const node = { kind: 'node' as const, items: ['26.13.1'], for: ['open' as const], command: 'curl …' };
    const blocked = { ...packages, blocked: 'admin' as const };
    expect(canInstall({ platform: 'linux', needs: [packages] })).toBe(true);
    expect(canInstall({ platform: 'linux', needs: [blocked] })).toBe(false);
    expect(canInstall({ platform: 'linux', needs: [node, blocked] })).toBe(true);
    expect(canInstall({ platform: 'linux', needs: [packages], job: job('running') })).toBe(false);
    expect(canInstall({ platform: 'linux', needs: [] })).toBe(false);
    expect(byHand({ platform: 'linux', needs: [node, blocked] })).toEqual([blocked]);
    // A need with no command (no build of Node.js for this computer) has nothing to copy.
    expect(byHand({ platform: 'linux', needs: [{ ...node, command: '', blocked: 'node' }] })).toEqual([]);
    expect(setupRunning({ platform: 'linux', needs: [], job: job('running') })).toBe(true);
    expect(setupRunning({ platform: 'linux', needs: [], job: job('failed') })).toBe(false);
  });

  it('names whose sandboxes need it', () => {
    expect(usersText(['claude', 'copilot', 'open'], (p) => p.toUpperCase(), 'the open-source agents')).toBe(
      'CLAUDE, COPILOT, the open-source agents',
    );
    // Chinese lists with 、.
    expect(usersText(['claude', 'open'], (p) => p, '開源 agent', '、')).toBe('claude、開源 agent');
  });

  it('asks again where the browser keeps nothing (no storage here)', () => {
    expect(() => writeAsked()).not.toThrow();
    expect(readAsked()).toBe(false);
  });
});
