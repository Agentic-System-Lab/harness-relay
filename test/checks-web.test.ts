import { describe, expect, it } from 'vitest';
import { badCommitPattern, badPath, cardActions, fixCandidates, listFrom, pathsFromText, pathsText, ruleCount } from '../src/web/checks';
import type { AgentConfig, ChatMessage, ChecksResult } from '../src/shared/types';

const card = (checks: Partial<ChecksResult> = {}): ChatMessage => ({
  id: 'c',
  author: { kind: 'system' },
  createdAt: 0,
  parts: [],
  status: 'done',
  checks: { status: 'failed', when: 'run', outcomes: [], checkedAt: 0, ...checks },
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
    expect(cardActions(card(), true, false)).toEqual({ recheck: true, fix: true, skip: true });
    expect(cardActions(card(), false, false)).toEqual({ recheck: false, fix: false, skip: false });
    expect(cardActions(card(), true, true)).toEqual({ recheck: false, fix: false, skip: false });
    expect(cardActions(card({ status: 'running' }), true, false).recheck).toBe(false);
  });

  it('offers Fix and Skip only while it fails and was not skipped; Check again always', () => {
    expect(cardActions(card({ status: 'passed' }), true, false)).toEqual({ recheck: true, fix: false, skip: false });
    expect(cardActions(card({ status: 'error' }), true, false)).toEqual({ recheck: true, fix: true, skip: true });
    expect(cardActions(card({ skippedAt: 1 }), true, false)).toEqual({ recheck: true, fix: false, skip: false });
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
