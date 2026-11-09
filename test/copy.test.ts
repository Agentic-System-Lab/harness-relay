import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { closeFences, conversationMarkdown, copyText, mentionWarning, messageText, planChecksMentions, planHeadline, planWording, teamChangeText } from '../src/web/copy';
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

describe('a scheduled message that @mentions someone the team does not have', () => {
  it('says that name reaches nobody, and who answers then: the members it does @mention, or the whole team', () => {
    expect(mentionWarning('@Alice look', ['Alice'], en, 'form')).toBeUndefined();
    expect(mentionWarning('@Zed look', ['Alice'], en, 'form')).toBe('@Zed in the message is not on this team, so it reaches nobody; with no member @mentioned, the whole team answers.');
    expect(mentionWarning('@Alice and @Zed', ['Alice'], en, 'form')).toBe('@Zed in the message is not on this team, so it reaches nobody; only @Alice answers.');
    expect(mentionWarning('@Alice, @Bob, @Zed and @Yan', ['Alice', 'Bob'], en, 'team')).toBe(
      '@Zed, @Yan in the scheduled message are not on this team, so they reach nobody; only @Alice, @Bob answer.',
    );
    expect(mentionWarning('@dddd 看一下', ['Reviewer'], zhTW, 'card')).toBe(
      '排程訊息裡的 @dddd 不在這個團隊裡，不會傳給任何人；訊息沒有 @ 任何成員，所以由整個團隊回答。可以按「調整團隊」為成員改名。',
    );
    expect(mentionWarning('@Reviewer 和 @dddd', ['Reviewer'], zhTW, 'form')).toBe('訊息裡的 @dddd 不在這個團隊裡，不會傳給任何人；只有 @Reviewer 會回答。');
  });

  it("checks a team design's members while it waits for confirmation, or when it was used at once and is the latest", () => {
    const lead = { provider: 'claude' as const };
    expect(planChecksMentions({ status: 'ready', lead, awaitingConfirmation: true }, false)).toBe(true);
    expect(planChecksMentions({ status: 'ready', lead, autoConfirmed: true, confirmedAt: 1 }, true)).toBe(true);
    expect(planChecksMentions({ status: 'ready', lead, autoConfirmed: true, confirmedAt: 1 }, false)).toBe(false); // an older one
    expect(planChecksMentions({ status: 'ready', lead, confirmedAt: 1 }, true)).toBe(false); // confirmed: the team editor warns now
    expect(planChecksMentions({ status: 'planning', lead }, true)).toBe(false);
  });
});

describe('naming the team the lead agent chose', () => {
  const lead = { provider: 'claude' as const };
  it("words a design for a schedule's message apart from one for a question", () => {
    const question = planWording({ status: 'ready', lead }, en, 'Claude Code');
    expect(question.confirmHint).toBe(en.plan.confirmHint);
    expect(question.aborted).toBe(en.plan.aborted);
    const schedule = planWording({ status: 'planning', lead, forSchedule: true }, zhTW, 'Claude Code');
    expect(schedule).toEqual({
      planning: '首席 agent（Claude Code）正在為這個排程組隊…',
      confirmHint: zhTW.plan.confirmHintSchedule,
      aborted: zhTW.plan.abortedSchedule,
    });
    expect(schedule.confirmHint).toMatch(/不會執行/);
  });

  it('says whether the current team was kept, a template used, adapted or designed', () => {
    expect(planHeadline({ status: 'ready', lead, source: 'kept', name: 'A · B' }, en)).toBe('Keeping the current team');
    // A failed design keeps the current team, or uses the default template when there is none.
    expect(planHeadline({ status: 'ready', lead, source: 'fallback', name: 'A · B' }, en)).toBe('Keeping the current team');
    expect(planHeadline({ status: 'ready', lead, source: 'fallback', presetId: 'builtin-general', name: 'General' }, en)).toBe(
      'Using the template "General" instead',
    );
    expect(planHeadline({ status: 'ready', lead, source: 'adapted', name: 'Pair', basedOn: { id: 'x', name: 'Debate' } }, zhTW)).toBe(
      '依範本「Debate」調整的團隊「Pair」',
    );
  });

  it('says in a copied conversation when the user declined the design', () => {
    const declined: Conversation = {
      ...conv,
      messages: [
        { id: 'p', author: { kind: 'system' }, createdAt: 0, status: 'done', parts: [], plan: { status: 'ready', lead, source: 'custom', name: 'Solo', declinedAt: 1 } },
      ],
    };
    expect(conversationMarkdown(declined, en)).toContain('*Team design: Custom team "Solo" (Not used; the current team answered)*');
  });
});

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

describe('copying exactly what was written', () => {
  const original = [
    'Links: https://example.com/a_b_c?x=1&y=2#frag_1 and <https://example.com/path(with)parens>',
    '[文件](https://github.com/org/repo/blob/main/docs/a%20b.md "標題") ![圖](https://example.com/x.png?d=1&e=2)',
    '**粗體** _斜體_ ~~刪除~~ ``a ` b`` \\*escaped\\* &amp; &lt;div&gt; <b>raw</b> @Bob',
    'two trailing spaces  ',
    'tab\there',
    '',
    '| a | b |',
    '| - | - |',
    '| `x\\|y` | [l](https://x.example/?q=a%7Cb) |',
    '',
    '```ts',
    'const url = "https://example.com/?a=1&b=2";   ',
    '```',
    '😀 全形：「」\r\nCRLF line\r\nlast line',
  ].join('\n');

  it('keeps URLs, Markdown, HTML, whitespace and line endings of a reply as they are', () => {
    const tool = { type: 'tool', id: 't', name: 'Read', status: 'done' } as unknown as ChatMessage['parts'][number];
    const m: ChatMessage = {
      id: 'm',
      author: { kind: 'agent', agentId: 'a' },
      createdAt: 0,
      status: 'done',
      parts: [{ type: 'text', text: original }, tool, { type: 'text', text: 'second https://example.com/end_(x)' }],
    };
    expect(messageText(m)).toBe(`${original}\n\nsecond https://example.com/end_(x)`);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('puts the text on the clipboard as it is', async () => {
    let written: string | undefined;
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void (written = t) } });
    expect(await copyText(original)).toBe(true);
    expect(written).toBe(original);
  });

  /** A page without the clipboard API (not https or localhost); its textarea turns CRLF into LF. */
  function legacyPage() {
    const steps: string[] = [];
    const listeners = new Map<string, (e: unknown) => void>();
    let value = '';
    let copied: string | undefined;
    const textarea = {
      style: {},
      get value() {
        return value;
      },
      set value(v: string) {
        value = v.replace(/\r\n/g, '\n');
      },
      setAttribute: () => {},
      select: () => steps.push('select'),
      setSelectionRange: (from: number, to: number) => steps.push(`range ${from}-${to}`),
      remove: () => steps.push('removed'),
    };
    const document = {
      activeElement: { focus: () => steps.push('focus back') },
      body: { appendChild: () => {} },
      createElement: () => textarea,
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string, fn: unknown) => listeners.get(type) === fn && listeners.delete(type),
      execCommand: (command: string) => {
        listeners.get(command)?.({ clipboardData: { setData: (_: string, d: string) => (copied = d) }, preventDefault: () => {} });
        return copied !== undefined;
      },
    };
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', document);
    return { steps, listeners, copied: () => copied, selected: () => value };
  }

  it('keeps CRLF line endings when it has to copy the legacy way', async () => {
    const page = legacyPage();
    expect(await copyText(original)).toBe(true);
    expect(page.copied()).toBe(original);
    // Selected in full first (iOS needs the range), then cleaned up, and focus goes back to the button.
    expect(page.steps).toEqual(['select', `range 0-${page.selected().length}`, 'removed', 'focus back']);
    expect(page.listeners.size).toBe(0);
  });
});

describe("the lead agent's changes to a team, in words", () => {
  it('says each kind of change in both languages', () => {
    const changes = [
      { kind: 'added', name: 'Tester', provider: 'codex' },
      { kind: 'removed', name: 'Bob' },
      { kind: 'renamed', from: 'Bob', name: 'Builder' },
      { kind: 'cli', name: 'Builder', provider: 'grok' },
      { kind: 'role', name: 'Alice' },
      { kind: 'model', name: 'Alice' },
      { kind: 'order' },
      { kind: 'mode', mode: 'relay' },
      { kind: 'rounds', rounds: 1 },
      { kind: 'hops', maxHops: 4 },
    ] as const;
    expect(changes.map((c) => teamChangeText(c, en))).toEqual([
      'added @Tester (Codex)',
      'removed @Bob',
      'renamed @Bob to @Builder',
      'moved @Builder to Grok',
      "rewrote @Alice's role",
      "changed @Alice's model or effort",
      'changed the speaking order',
      'switched to Relay mode',
      '1 round',
      'at most 4 hand-offs',
    ]);
    expect(changes.map((c) => teamChangeText(c, zhTW))).toEqual([
      '新增 @Tester（Codex）',
      '移除 @Bob',
      '@Bob 改名為 @Builder',
      '@Builder 改用 Grok',
      '改寫 @Alice 的角色',
      '調整 @Alice 的模型或推理強度',
      '調整發言順序',
      '改成接力模式',
      '改成 1 輪',
      '最多交棒 4 次',
    ]);
  });
});
