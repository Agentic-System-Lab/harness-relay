import { describe, expect, it } from 'vitest';
import { CHECKS_SCHEMA, buildChecksPrompt, decideChecks } from '../src/server/checksDraft';

describe('team checks the lead agent writes', () => {
  it('reads the project when there is one, and says there is none for a template or the default', () => {
    const team = buildChecksPrompt('run the tests', { commands: [{ id: 'c1', run: 'npm test' }] }, { cwds: ['/p', '/q'] }, 'team', 'linux');
    expect(team).toContain('The team works in the working directories /p, /q, and you are running in /p, read-only.');
    expect(team).toContain('Propose only commands that exist in this project');
    expect(team).toContain('"run": "npm test"');
    // The ids Harness Relay keeps for results are not the lead's to see.
    expect(team).not.toContain('c1');
    expect(team).toContain('<request>\nrun the tests\n</request>');
    expect(buildChecksPrompt('x', undefined, undefined, 'template')).toContain('This is the list of a team template');
    const defaults = buildChecksPrompt('x', undefined, undefined, 'defaults');
    expect(defaults).toContain("This is Harness Relay's default list in Settings");
    expect(defaults).toContain('Leave "hooks" empty');
  });

  it('says that commands and hooks do not run on Windows yet, there only', () => {
    expect(buildChecksPrompt('x', undefined, undefined, 'team', 'win32')).toContain('Commands do not run on Windows yet');
    expect(buildChecksPrompt('x', undefined, undefined, 'team', 'darwin')).not.toContain('Windows');
  });

  it('asks for the whole list in the strict shape', () => {
    expect(CHECKS_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ['protectedPaths', 'commitPattern', 'commands', 'hooks', 'previewApp', 'autoFix', 'reason'],
    });
  });

  it('keeps the ids of the rules it kept, and what it left out as the list had it', () => {
    const before = {
      protectedPaths: ['.env'],
      commitPattern: '^feat',
      commands: [{ id: 'keep', run: 'npm test' }],
      hooks: [{ id: 'h', when: 'before' as const, tools: 'command' as const, run: './allow.sh' }],
      autoFix: true as const,
    };
    const r = decideChecks(
      {
        commands: [
          { run: 'npm test', cwd: '', timeoutMin: null },
          { run: 'npm run lint', cwd: 'web' },
        ],
        reason: ' ok ',
      },
      before,
    );
    expect(r).toEqual({
      checks: {
        protectedPaths: ['.env'],
        commitPattern: '^feat',
        commands: [{ id: 'keep', run: 'npm test' }, expect.objectContaining({ run: 'npm run lint', cwd: 'web' })],
        hooks: [{ id: 'h', when: 'before', tools: 'command', run: './allow.sh' }],
        autoFix: true,
      },
      reason: 'ok',
      dropped: 0,
    });
  });

  it('leaves out each rule it cannot use, counting them, and keeps the others', () => {
    const r = decideChecks(
      {
        protectedPaths: ['..', '.env'],
        commitPattern: '([',
        commands: [{ run: '' }, { run: 'make', timeoutMin: 999 }, { run: 'ok' }],
        hooks: [{ when: 'sometimes', tools: 'any', run: 'x' }],
        previewApp: true,
        reason: '',
      },
      undefined,
    );
    expect(r.checks).toEqual({ protectedPaths: ['.env'], commands: [expect.objectContaining({ run: 'ok' })], previewApp: true });
    expect(r.dropped).toBe(5);
  });

  it('keeps the hooks of Settings’ default as they are, whatever the lead gave', () => {
    const r = decideChecks({ hooks: [{ when: 'after', tools: 'edit', run: 'x' }], reason: '' }, undefined, true);
    expect(r.checks).toEqual({});
  });
});
