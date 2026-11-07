import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PROVIDER_LABEL, type ChatMessage, type Conversation, type MessagePart } from '../../shared/types';
import { messageText } from '../copy';
import { PROVIDER_COLOR, formatDuration, formatTokens, initials } from '../util';
import { ChangesCard, type ApplyState } from './ChangesCard';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type Segment = { kind: 'text'; text: string; key: number } | { kind: 'tools'; tools: ToolPart[]; key: number };

function segments(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((p, i) => {
    const last = out[out.length - 1];
    if (p.type === 'text') {
      if (p.text.trim()) out.push({ kind: 'text', text: p.text, key: i });
    } else if (last?.kind === 'tools') last.tools.push(p);
    else out.push({ kind: 'tools', tools: [p], key: i });
  });
  return out;
}

function ToolGroup({ tools, live }: { tools: ToolPart[]; live: boolean }) {
  const running = tools.find((t) => t.status === 'running');
  const failed = tools.filter((t) => t.status === 'error').length;
  const summary = running && live ? `${running.name}${running.detail ? ` · ${running.detail}` : ''}` : `${tools.length} 個動作`;
  return (
    <details className="tool-group">
      <summary>
        <span className={`tool-icon ${running && live ? 'spin' : ''}`} aria-hidden>
          {running && live ? '◌' : '⚙'}
        </span>
        <span className="tool-summary">{summary}</span>
        {failed > 0 && <span className="tool-failed">{failed} 個失敗</span>}
      </summary>
      <ul>
        {tools.map((t) => (
          <li key={t.id} className={`tool ${t.status}`}>
            <span className="tool-status" aria-label={t.status}>
              {t.status === 'running' ? '…' : t.status === 'done' ? '✓' : '✗'}
            </span>
            <code className="tool-name">{t.name}</code>
            {t.detail && <span className="tool-detail">{t.detail}</span>}
            {t.status === 'error' && t.error && <div className="tool-error">{t.error}</div>}
          </li>
        ))}
      </ul>
    </details>
  );
}

interface Props {
  msg: ChatMessage;
  conv: Conversation;
  mentionNames: string[];
  applyState?: ApplyState;
  /** The team is replying: messages cannot be edited until it stops. */
  running: boolean;
  onDiff: (msg: ChatMessage, scope: 'turn' | 'agent') => void;
  onApply: (agentId: string) => Promise<void>;
  /** Replace a user message and run the team again from it; resolves true once sent. */
  onResend: (messageId: string, text: string) => Promise<boolean>;
}

/** One of the user's messages, editable in place. */
function UserMessage({
  msg,
  mentionNames,
  canEdit,
  onResend,
}: {
  msg: ChatMessage;
  mentionNames: string[];
  canEdit: boolean;
  onResend: Props['onResend'];
}) {
  const text = messageText(msg);
  const [draft, setDraft] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow, like the composer.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft]);

  if (draft === null) {
    return (
      <div className="msg-user">
        <div className="bubble">
          <Markdown text={text} mentions={mentionNames} />
        </div>
        <div className="msg-actions">
          <CopyButton text={() => text} />
          {canEdit && (
            <button type="button" className="msg-action" onClick={() => setDraft(text)}>
              編輯
            </button>
          )}
        </div>
      </div>
    );
  }

  const ready = draft.trim().length > 0 && canEdit && !sending;
  const submit = async () => {
    if (!ready) return;
    setSending(true);
    const ok = await onResend(msg.id, draft);
    setSending(false);
    if (ok) setDraft(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME candidate selection
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="msg-user">
      <div className="edit-box">
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          autoFocus
          aria-label="編輯訊息"
        />
        <div className="edit-foot">
          <span className="muted small">
            {canEdit ? '重新傳送後，這則之後的對話會被刪除，團隊從這裡重新回答。' : '團隊回覆中，停止後才能重新傳送。'}
          </span>
          <button type="button" className="ghost small-button" onClick={() => setDraft(null)}>
            取消
          </button>
          <button type="button" className="primary small-button" disabled={!ready} onClick={submit}>
            {sending ? '傳送中…' : '傳送'}
          </button>
        </div>
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  msg,
  conv,
  mentionNames,
  applyState,
  running,
  onDiff,
  onApply,
  onResend,
}: Props) {
  if (msg.author.kind === 'system') {
    return (
      <div className="msg-system">
        <span>{msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</span>
      </div>
    );
  }

  if (msg.author.kind === 'user') {
    return <UserMessage msg={msg} mentionNames={mentionNames} canEdit={!running} onResend={onResend} />;
  }

  const agentId = msg.author.agentId;
  const agent = conv.agents.find((a) => a.id === agentId);
  const name = agent?.name ?? msg.agentName ?? 'agent';
  const provider = msg.provider ?? agent?.provider ?? 'claude';
  const live = msg.status === 'streaming';
  const segs = segments(msg.parts);
  const m = msg.meta;
  const hasMeta = Boolean(m && (m.durationMs || m.costUsd || m.outputTokens));
  const copyable = !msg.passed && messageText(msg).length > 0;

  return (
    <div className={`msg-agent ${msg.passed ? 'passed' : ''}`} style={{ ['--accent' as string]: PROVIDER_COLOR[provider] }}>
      <span className="avatar">{initials(name)}</span>
      <div className="msg-body">
        <div className="msg-head">
          <strong>@{name}</strong>
          <span className="provider-tag">{PROVIDER_LABEL[provider]}</span>
          {m?.round && conv.settings.mode !== 'relay' && conv.settings.rounds > 1 && (
            <span className="round-tag">第 {m.round} 輪</span>
          )}
          {live && <span className="live-tag">回覆中</span>}
        </div>

        {msg.passed && msg.status === 'done' ? (
          <p className="muted small">沒有補充（PASS）</p>
        ) : (
          segs.map((s) =>
            s.kind === 'text' ? (
              <Markdown key={s.key} text={s.text} mentions={mentionNames} />
            ) : (
              <ToolGroup key={s.key} tools={s.tools} live={live} />
            ),
          )
        )}

        {live && segs.length === 0 && (
          <div className="typing" aria-label="思考中">
            <i />
            <i />
            <i />
          </div>
        )}
        {msg.changes && msg.changes.files.length > 0 && (
          <ChangesCard
            changes={msg.changes}
            agentName={name}
            applyState={applyState}
            onDiff={(scope) => onDiff(msg, scope)}
            onApply={() => onApply(agentId)}
          />
        )}
        {msg.status === 'error' && <div className="msg-error">⚠ {msg.error}</div>}
        {msg.status === 'aborted' && <p className="muted small">（已中斷）</p>}

        {!live && (hasMeta || copyable) && (
          <div className="msg-actions">
            {hasMeta && m && (
              <span className="msg-meta">
                {formatDuration(m.durationMs)}
                {m.costUsd !== undefined && ` · $${m.costUsd.toFixed(3)}`}
                {m.inputTokens !== undefined && ` · ${formatTokens(m.inputTokens)} in`}
                {m.outputTokens !== undefined && ` / ${formatTokens(m.outputTokens)} out`}
              </span>
            )}
            {copyable && <CopyButton text={() => messageText(msg)} />}
          </div>
        )}
      </div>
    </div>
  );
});
