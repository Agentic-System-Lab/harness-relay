import { memo } from 'react';
import { PROVIDER_LABEL, type ChatMessage, type Conversation, type MessagePart } from '../../shared/types';
import { PROVIDER_COLOR, formatDuration, formatTokens, initials } from '../util';
import { ChangesCard, type ApplyState } from './ChangesCard';
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
  onDiff: (msg: ChatMessage, scope: 'turn' | 'agent') => void;
  onApply: (agentId: string) => Promise<void>;
}

export const MessageItem = memo(function MessageItem({ msg, conv, mentionNames, applyState, onDiff, onApply }: Props) {
  if (msg.author.kind === 'system') {
    return (
      <div className="msg-system">
        <span>{msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}</span>
      </div>
    );
  }

  if (msg.author.kind === 'user') {
    const text = msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <div className="msg-user">
        <div className="bubble">
          <Markdown text={text} mentions={mentionNames} />
        </div>
      </div>
    );
  }

  const agentId = msg.author.agentId;
  const agent = conv.agents.find((a) => a.id === agentId);
  const name = agent?.name ?? msg.agentName ?? 'agent';
  const provider = msg.provider ?? agent?.provider ?? 'claude';
  const live = msg.status === 'streaming';
  const segs = segments(msg.parts);
  const m = msg.meta;

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

        {!live && m && (m.durationMs || m.costUsd || m.outputTokens) ? (
          <div className="msg-meta">
            {formatDuration(m.durationMs)}
            {m.costUsd !== undefined && ` · $${m.costUsd.toFixed(3)}`}
            {m.inputTokens !== undefined && ` · ${formatTokens(m.inputTokens)} in`}
            {m.outputTokens !== undefined && ` / ${formatTokens(m.outputTokens)} out`}
          </div>
        ) : null}
      </div>
    </div>
  );
});
