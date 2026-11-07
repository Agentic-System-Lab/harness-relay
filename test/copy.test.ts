import { describe, expect, it } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { closeFences, conversationMarkdown, messageText } from '../src/web/copy';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

const conv: Conversation = {
  id: 'c',
  title: '影片重點',
  createdAt: 0,
  updatedAt: 0,
  agents: [
    { id: 'a', name: 'Analyst', provider: 'claude', role: '' },
    { id: 'b', name: 'Critic', provider: 'grok', role: '' },
  ],
  settings: { mode: 'roundtable', rounds: 1, maxHops: 6, permission: 'read-only', cwd: '/tmp' },
  messages: [
    { id: 'm1', author: { kind: 'user' }, createdAt: 1, status: 'done', parts: [{ type: 'text', text: '幫我整理重點' }] },
    {
      id: 'm2',
      author: { kind: 'agent', agentId: 'a' },
      agentName: 'Analyst',
      provider: 'claude',
      createdAt: 2,
      status: 'done',
      parts: [
        { type: 'text', text: '先查資料。' },
        { type: 'tool', id: 't', name: 'WebFetch', status: 'done' },
        { type: 'text', text: '## 重點\n\n- 一\n- 二' },
      ],
    },
    {
      id: 'm3',
      author: { kind: 'agent', agentId: 'b' },
      createdAt: 3,
      status: 'done',
      passed: true,
      parts: [{ type: 'text', text: '[PASS]' }],
    },
    {
      id: 'm4',
      author: { kind: 'agent', agentId: 'b' },
      provider: 'grok',
      createdAt: 4,
      status: 'error',
      error: '執行逾時',
      parts: [{ type: 'text', text: '我核對一下。' }],
    },
    { id: 'm5', author: { kind: 'system' }, createdAt: 5, status: 'done', parts: [{ type: 'text', text: '已停止。' }] },
  ],
  agentState: {},
  worktrees: {},
};

describe('copying a conversation', () => {
  it('joins a message\'s text blocks and leaves tool activity out', () => {
    expect(messageText(conv.messages[1]!)).toBe('先查資料。\n\n## 重點\n\n- 一\n- 二');
  });

  it('writes the whole conversation as Markdown, labelled by speaker', () => {
    expect(conversationMarkdown(conv, zhTW)).toBe(
      [
        '# 影片重點',
        '',
        '**使用者**',
        '',
        '幫我整理重點',
        '',
        '---',
        '',
        '**@Analyst** · Claude Code',
        '',
        '先查資料。',
        '',
        '## 重點',
        '',
        '- 一',
        '- 二',
        '',
        '---',
        '',
        '**@Critic** · Grok',
        '',
        '我核對一下。',
        '',
        '> ⚠ 執行逾時',
        '',
        '---',
        '',
        '*已停止。*',
        '',
      ].join('\n'),
    );
  });

  it('labels the transcript in the UI language', () => {
    const md = conversationMarkdown(conv, en);
    expect(md).toContain('**User**\n\n幫我整理重點');
    expect(md).not.toContain('使用者');
  });

  it('lists the files attached to a user message', () => {
    const withFiles: Conversation = {
      ...conv,
      messages: [
        {
          id: 'u',
          author: { kind: 'user' },
          createdAt: 1,
          status: 'done',
          parts: [
            { type: 'text', text: 'Look at this' },
            { type: 'attachment', id: 'f', name: 'screen.png', mimeType: 'image/png', size: 10 },
          ],
        },
      ],
    };
    expect(conversationMarkdown(withFiles, en)).toContain('**User**\n\nLook at this\n\n📎 screen.png');
  });
});

const agentMsg = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({
  id,
  author: { kind: 'agent', agentId: 'a' },
  createdAt: 0,
  status: 'done',
  parts: [],
  ...extra,
});

describe('copying code and errors', () => {
  it('closes a code fence a stopped reply left open, so later messages stay outside it', () => {
    const md = conversationMarkdown(
      {
        ...conv,
        messages: [
          agentMsg('x', { status: 'aborted', parts: [{ type: 'text', text: '看這段：\n\n````ts\nconst a = 1;\n```\nstill code' }] }),
          agentMsg('y', { parts: [{ type: 'text', text: '下一則' }] }),
        ],
      },
      en,
    );
    expect(md).toContain('still code\n````\n\n*(stopped)*\n\n---\n\n**@Analyst**');
  });

  it('closes backtick and tilde fences of any length, and leaves closed ones alone', () => {
    expect(closeFences('```js\ncode')).toBe('```js\ncode\n```');
    expect(closeFences('~~~~\ncode\n~~~\n')).toBe('~~~~\ncode\n~~~\n~~~~');
    expect(closeFences('```\na\n```\ntext')).toBe('```\na\n```\ntext');
    expect(closeFences('~~~\na\n```\n~~~')).toBe('~~~\na\n```\n~~~');
    // Inside a list item, the block is closed inside the item (a fence at column 0 would end the list
    // and open a new block that swallows the rest of the transcript).
    expect(closeFences('1. Install:\n   ```bash\n   npm install')).toBe('1. Install:\n   ```bash\n   npm install\n   ```');
    // Not fences: inline code with backticks in the "info string", and an indented code block.
    expect(closeFences('``` `x` ```')).toBe('``` `x` ```');
    expect(closeFences('    ```\n    code')).toBe('    ```\n    code');
  });

  it('keeps one text block\'s open fence from running into the next', () => {
    const m = agentMsg('x', {
      parts: [
        { type: 'text', text: '```\npartial' },
        { type: 'tool', id: 't', name: 'Bash', status: 'done' },
        { type: 'text', text: 'after the tool' },
      ],
    });
    expect(messageText(m)).toBe('```\npartial\n```\n\nafter the tool');
  });

  it("keeps the first line's indentation (an indented code block)", () => {
    const m = agentMsg('x', { parts: [{ type: 'text', text: '\n\n    npm test\n    npm run build\n\n' }] });
    expect(messageText(m)).toBe('    npm test\n    npm run build');
  });

  it('quotes every line of a multi-line error', () => {
    const md = conversationMarkdown(
      { ...conv, messages: [agentMsg('x', { status: 'error', error: 'exit 1\nstderr: boom\n', parts: [{ type: 'text', text: 'trying' }] })] },
      en,
    );
    expect(md).toContain('trying\n\n> ⚠ exit 1\n> stderr: boom\n');
  });

  it('labels a reply with the name and coding agent it had then', () => {
    const renamed = { ...conv, agents: [{ id: 'a', name: 'Researcher', provider: 'codex' as const, role: '' }] };
    const md = conversationMarkdown(
      { ...renamed, messages: [agentMsg('x', { agentName: 'Analyst', provider: 'claude', parts: [{ type: 'text', text: 'hi' }] })] },
      en,
    );
    expect(md).toContain('**@Analyst** · Claude Code\n\nhi');
    // Old messages without a snapshot fall back to the agent as it is now.
    const fallback = conversationMarkdown({ ...renamed, messages: [agentMsg('x', { parts: [{ type: 'text', text: 'hi' }] })] }, en);
    expect(fallback).toContain('**@Researcher** · Codex\n\nhi');
  });
});
