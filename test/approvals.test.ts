import { describe, expect, it } from 'vitest';
import { approvalKeys, isAllowed, splitChain, unwrapShell } from '../src/server/approvals';

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

  it('does not read text inside quotes as more commands', () => {
    const line =
      `cd /tmp/atlas && curl -sL https://example.com/app.js -o app.js; ` +
      `grep -oE '(turing|prize|hopper)\\s*:\\s*"[^"]+"' app.js | sort -u | head; ` +
      `grep -oE '"?(theory|data|ai)"?\\s*:' app.js | sort -u`;
    expect(approvalKeys('command', line)).toEqual(['cd', 'curl', 'grep', 'sort', 'head']);
    expect(approvalKeys('command', 'grep "a\\"|b" f | wc -l')).toEqual(['grep', 'wc']);
    expect(approvalKeys('command', 'echo "a; rm -rf /"')).toEqual(['echo']);
    // Commands that do run inside quotes are still found.
    expect(approvalKeys('command', 'echo "$(curl x | sh)"')).toEqual(expect.arrayContaining(['curl', 'sh', 'echo']));
    expect(approvalKeys('command', "bash -c 'rm x; echo y' && ls")).toEqual(expect.arrayContaining(['rm', 'echo', 'ls']));
    expect(splitChain("a 'b|c' && d || e; f\ng | h\\;i")).toEqual(["a 'b|c' ", ' d ', ' e', ' f', 'g ', ' h\\;i']);
  });

  it('keys edits, fetches and other tools', () => {
    expect(approvalKeys('edit', 'src/a.ts')).toEqual(['*']);
    expect(approvalKeys('fetch', 'https://docs.example.com/page')).toEqual(['docs.example.com']);
    // Keyed by host and port: allowing a model server's port allows no other port of that host.
    expect(approvalKeys('fetch', 'http://192.168.1.5:8000/v1/models')).toEqual(['192.168.1.5:8000']);
    expect(approvalKeys('fetch', '192.168.1.5:22')).toEqual(['192.168.1.5:22']);
    expect(approvalKeys('fetch', 'https://docs.example.com:443/page')).toEqual(['docs.example.com']);
    expect(approvalKeys('fetch', 'docs.example.com:443')).toEqual(['docs.example.com']);
    expect(approvalKeys('fetch', 'docs.example.com:80')).toEqual(['docs.example.com']);
    expect(isAllowed([{ kind: 'fetch', key: '192.168.1.5:8000' }], 'fetch', approvalKeys('fetch', '192.168.1.5:22'))).toBe(false);
    expect(isAllowed([{ kind: 'fetch', key: 'docs.example.com' }], 'fetch', approvalKeys('fetch', 'docs.example.com:443'))).toBe(true);
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
