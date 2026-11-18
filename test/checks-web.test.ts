import { describe, expect, it } from 'vitest';
import {
  badCommitPattern,
  badPath,
  cardActions,
  commandProblem,
  fixCandidates,
  gatedFiles,
  listFrom,
  pathsFromText,
  pathsText,
  ruleCount,
} from '../src/web/checks';
import type { AgentConfig, ChatMessage, ChecksResult } from '../src/shared/types';

const card = (checks: Partial<ChecksResult> = {}): ChatMessage => ({
  id: 'c',
  author: { kind: 'system' },
  createdAt: 0,
  parts: [],
  status: 'done',
  checks: { status: 'failed', when: 'run', outcomes: [{ rule: 'paths', status: 'failed' }], checkedAt: 0, ...checks },
});

describe('team checks editor', () => {
  it('reads a pattern a line, each once, and writes them back the same way', () => {
    expect(pathsFromText(' .env \n\n*.pem\n.env\n')).toEqual(['.env', '*.pem']);
    expect(pathsText({ protectedPaths: ['.env', 'secrets/'] })).toBe('.env\nsecrets/');
    expect(pathsText(undefined)).toBe('');
  });

  it('points at a line that cannot be a pattern, and a commit pattern JavaScript cannot read', () => {
    expect(badPath('.env\n../up\n')).toBe('../up');
    expect(badPath('.env\nsecrets/')).toBeUndefined();
    expect(badCommitPattern('(')).toBeTruthy();
    expect(badCommitPattern('  ')).toBeUndefined();
    expect(badCommitPattern('^feat')).toBeUndefined();
  });

  it('makes no list for one that had none, and keeps an emptied one as an empty list', () => {
    expect(listFrom('', ' ', undefined)).toBeUndefined();
    expect(listFrom('', '', { protectedPaths: ['.env'] })).toEqual({});
    expect(listFrom('.env\n', ' ^feat ', undefined)).toEqual({ protectedPaths: ['.env'], commitPattern: '^feat' });
    expect(listFrom('', '^fix', {})).toEqual({ commitPattern: '^fix' });
    expect(ruleCount({ protectedPaths: ['a', 'b'], commitPattern: 'x' })).toBe(3);
    expect(ruleCount(undefined)).toBe(0);
  });
});

describe('team checks card', () => {
  it('offers something on the latest result only, and nothing while the team replies', () => {
    expect(cardActions(card(), true, false)).toEqual({ recheck: true, fix: true, skip: true, confirm: false });
    expect(cardActions(card(), false, false)).toEqual({ recheck: false, fix: false, skip: false, confirm: false });
    expect(cardActions(card(), true, true)).toEqual({ recheck: false, fix: false, skip: false, confirm: false });
    expect(cardActions(card({ status: 'running' }), true, false).recheck).toBe(false);
  });

  it('offers Fix and Skip only while it fails and was not skipped; Check again always', () => {
    expect(cardActions(card({ status: 'passed' }), true, false)).toEqual({ recheck: true, fix: false, skip: false, confirm: false });
    expect(cardActions(card({ status: 'error' }), true, false)).toEqual({ recheck: true, fix: true, skip: true, confirm: false });
    expect(cardActions(card({ skippedAt: 1 }), true, false)).toEqual({ recheck: true, fix: false, skip: false, confirm: false });
  });

  it('lists the members its findings name first', () => {
    const agents: AgentConfig[] = ['Alice', 'Bob', 'Carol'].map((name) => ({ id: name[0]!, name, provider: 'claude', role: '' }));
    const found = card({
      outcomes: [
        {
          rule: 'paths',
          status: 'failed',
          findings: [
            { path: '.env', change: 'changed', by: 'Carol' },
            { path: 'x', change: 'added' },
          ],
        },
        {
          rule: 'commits',
          status: 'failed',
          findings: [
            { commit: 'abc', subject: 'x', by: 'Bob' },
            { commit: 'def', subject: 'y', by: 'Carol' },
          ],
        },
      ],
    });
    expect(fixCandidates(found, agents).map((a) => a.name)).toEqual(['Carol', 'Bob', 'Alice']);
    // A member renamed since is not found by its old name.
    expect(
      fixCandidates(card({ outcomes: [{ rule: 'paths', status: 'failed', findings: [{ path: 'a', by: 'Dave' }] }] }), agents).map(
        (a) => a.name,
      ),
    ).toEqual(['Alice', 'Bob', 'Carol']);
  });
});

describe('team checks as Markdown', async () => {
  const { checksMarkdown } = await import('../src/web/copy');
  const { en } = await import('../src/web/locales/en');
  it('says its status, each rule, and what it found', () => {
    const md = checksMarkdown(
      {
        status: 'failed',
        when: 'run',
        checkedAt: 0,
        skippedAt: 1,
        outcomes: [
          { rule: 'paths', status: 'failed', findings: [{ path: '.env', change: 'changed', by: 'Bob' }], more: 2 },
          { rule: 'commits', status: 'na', reason: 'No new commit in this run.' },
        ],
      },
      en,
    );
    expect(md).toBe(
      [
        '*Team checks: Failed* (skipped)',
        '- **Protected paths**: Failed',
        "  - `.env` changed · in @Bob's turn",
        '  - 2 more',
        '- **Commit format**: Not applicable · No new commit in this run.',
      ].join('\n'),
    );
  });
});

describe('team checks: commands in the page', () => {
  it('keeps the rows with a command line, trimmed, the defaults left out', () => {
    expect(
      listFrom('', '', undefined, [
        { id: 'a', run: ' npm test ', cwd: ' app ', timeoutMin: 10, localPorts: false },
        { id: 'b', run: '  ' },
        { id: 'c', run: 'make lint', timeoutMin: 3, unixSockets: true },
      ]),
    ).toEqual({
      commands: [
        { id: 'a', run: 'npm test', cwd: 'app' },
        { id: 'c', run: 'make lint', timeoutMin: 3, unixSockets: true },
      ],
    });
    expect(ruleCount({ commands: [{ id: 'a', run: 'x' }], commitPattern: 'y' })).toBe(2);
  });

  it('says what is wrong with a row', () => {
    expect(commandProblem({ run: ' ' })).toBe('run');
    expect(commandProblem({ run: 'x', cwd: '../up' })).toBe('folder');
    expect(commandProblem({ run: 'x', timeoutMin: 0 })).toBe('timeout');
    expect(commandProblem({ run: 'x', timeoutMin: 61 })).toBe('timeout');
    expect(commandProblem({ run: 'x', cwd: '/abs/ok', timeoutMin: 60 })).toBeUndefined();
  });

  it('offers to confirm and run the commands a run kept from running', () => {
    const gated = card({
      outcomes: [{ rule: 'command', status: 'error', commandId: 'a', configChanged: ['package.json', 'eslint.config.js'] }],
    });
    expect(gatedFiles(gated)).toEqual(['package.json', 'eslint.config.js']);
    expect(cardActions(gated, true, false)).toEqual({ recheck: true, fix: false, skip: true, confirm: true });
  });
});

describe('team checks: what cannot be fixed', () => {
  it('asks no member to fix commands held back by changed settings, nor commands stopped or not run here', () => {
    const gated = card({ outcomes: [{ rule: 'command', status: 'error', commandId: 'a', configChanged: ['vitest.config.ts'] }] });
    expect(cardActions(gated, true, false)).toEqual({ recheck: true, fix: false, skip: true, confirm: true });
    const stopped = card({ status: 'error', outcomes: [{ rule: 'command', status: 'error', commandId: 'a', notRun: 'stopped' }] });
    expect(cardActions(stopped, true, false)).toEqual({ recheck: true, fix: false, skip: false, confirm: false });
  });
});
