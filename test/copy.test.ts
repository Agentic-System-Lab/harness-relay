import { describe, expect, it } from 'vitest';
import type { Conversation } from '../src/shared/types';
import { conversationMarkdown, messageText } from '../src/web/copy';
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
