import { describe, expect, it } from 'vitest';
import { approvalKeys, isAllowed, unwrapShell } from '../src/server/approvals';

describe('approval rules', () => {
  it('unwraps the shell CLIs put around commands', () => {
    expect(unwrapShell("/bin/zsh -lc 'npm test'")).toBe('npm test');
    expect(unwrapShell('bash -c "git push origin main"')).toBe('git push origin main');
    expect(unwrapShell('npm test')).toBe('npm test');
  });

  it('keys a command by program and subcommand, one key per chained command', () => {
    expect(approvalKeys('command', 'npm install lodash')).toEqual(['npm install']);
    expect(approvalKeys('command', "/bin/zsh -lc 'cd app && npm test -- --watch'")).toEqual(['cd', 'npm test']);
    expect(approvalKeys('command', 'FOO=1 /usr/bin/python3 script.py')).toEqual(['python3']);
    expect(approvalKeys('command', 'ls -la | grep x')).toEqual(['ls', 'grep']);
  });

  it('keys edits, fetches and other tools', () => {
    expect(approvalKeys('edit', 'src/a.ts')).toEqual(['*']);
    expect(approvalKeys('fetch', 'https://docs.example.com/page')).toEqual(['docs.example.com']);
    expect(approvalKeys('other', undefined, 'linear__create_issue')).toEqual(['linear__create_issue']);
    expect(approvalKeys('other')).toEqual([]);
  });

  it('allows a request only when every one of its keys was allowed', () => {
    const rules = [
      { kind: 'command' as const, key: 'npm test' },
      { kind: 'command' as const, key: 'cd' },
    ];
    expect(isAllowed(rules, 'command', approvalKeys('command', 'cd app && npm test'))).toBe(true);
    // Allowing `npm test` never lets a chained command through.
    expect(isAllowed(rules, 'command', approvalKeys('command', 'npm test && rm -rf /'))).toBe(false);
    expect(isAllowed(rules, 'edit', ['*'])).toBe(false);
    expect(isAllowed(rules, 'command', [])).toBe(false);
  });
});
