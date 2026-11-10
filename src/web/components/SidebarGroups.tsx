import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { ConversationGroup, ConversationSummary } from '../../shared/types';
import { GROUP_LIMITS } from '../../shared/types';
import { api } from '../api';
import type { Route } from '../App';
import { useI18n, useT } from '../i18n';
import { scheduleTrouble, sidebarScheduleTitle } from '../schedule';
import {
  DRAG_TYPE,
  MAX_INDENT,
  descendants,
  familyIds,
  familySizes,
  foldedNow,
  groupSections,
  groupStatus,
  moveFamily,
  readCollapsedBranches,
  readCollapsedGroups,
  revealIn,
  sectionKey,
  settleMoves,
  undoMoves,
  writeCollapsedBranches,
  writeCollapsedGroups,
  type ConvNode,
  type GroupSection,
} from '../sidebar';
import { convStatus, relativeTime } from '../util';
import { BranchIcon, ChevronIcon, ClockIcon, FolderIcon, FolderPlusIcon, PencilIcon } from './icons';
import { MemberDots } from './MemberDots';

interface Props {
  route: Route;
  conversations: ConversationSummary[];
  groups: ConversationGroup[];
  seen: Record<string, number>;
  /** Groups or conversations changed: load them again. */
  onChanged: () => void;
  onDelete: (c: ConversationSummary) => void;
}

/**
 * The new group's name field, which takes the place of the New group / Search buttons the way the
 * search field does: Enter creates the group, Escape or × closes it.
 */
export function NewGroupBox({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => input.current?.focus(), []);

  const save = async () => {
    const value = name.trim();
    if (busy || !value) return;
    setBusy(true);
    try {
      await api.createGroup(value);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      input.current?.focus();
      return;
    }
    onCreated();
    onClose();
  };

  return (
    <form
      className="sidebar-new-group"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="sidebar-field">
        <FolderPlusIcon size={16} />
        <input
          ref={input}
          value={name}
          maxLength={GROUP_LIMITS.maxName}
          placeholder={t.sidebar.groupName}
          aria-label={t.sidebar.groupName}
          aria-invalid={error ? true : undefined}
          enterKeyHint="done"
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            // Escape ends an IME composition first (Safari: keyCode 229), not the field.
            if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.cancel} title={t.common.cancel}>
          ×
        </button>
      </div>
      {error && (
        <p className="group-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** A field for a group's name: Enter saves, Escape cancels, leaving it saves what was typed (or cancels when empty). */
function GroupNameField({
  initial = '',
  onSave,
  onCancel,
}: {
  initial?: string;
  /** Resolves with an error message, or nothing when saved. */
  onSave: (name: string) => Promise<string | undefined>;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const value = name.trim();
    if (!value || value === initial) return onCancel();
    setBusy(true);
    const err = await onSave(value);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <form
      className="group-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={GROUP_LIMITS.maxName}
        placeholder={t.sidebar.groupName}
        aria-label={t.sidebar.groupName}
        aria-invalid={error ? true : undefined}
        enterKeyHint="done"
        onChange={(e) => {
          setName(e.target.value);
          setError('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!error) void save();
        }}
      />
      {error && (
        <p className="group-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * The conversations in their groups: the user's groups, then "Other". In a group, each conversation
 * branched from another is under it, and a family of them is dragged between groups as one.
 */
export function SidebarGroups({ route, conversations, groups, seen, onChanged, onDelete }: Props) {
  const { t, lang } = useI18n();
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  const [folded, setFolded] = useState(readCollapsedBranches);
  /** Moves not yet reported back by the server, so the conversation does not jump back meanwhile. */
  const [moves, setMoves] = useState<Record<string, string | null>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  /** The section a conversation is dragged over. */
  const [over, setOver] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => setMoves((m) => settleMoves(m, conversations)), [conversations]);

  // The conversation opened is in view: hidden branches that hold it open, once, when it is listed
  // (a new branch is listed a moment after it opens).
  const openId = route.page === 'chat' ? route.id : null;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!openId || revealed.current === openId || !conversations.some((c) => c.id === openId)) return;
    revealed.current = openId;
    const next = revealIn(folded, conversations, openId);
    if (next === folded) return;
    setFolded(next);
    writeCollapsedBranches(next);
    // Not on `folded`: hiding them again while it is open is up to the user.
  }, [openId, conversations]);

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    writeCollapsedGroups(next);
  };

  const fold = (id: string) => {
    // Nodes gone from the sidebar are forgotten meanwhile.
    const next = foldedNow(folded, conversations);
    if (folded.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
    writeCollapsedBranches(next);
  };

  const sections = groupSections(conversations, groups, moves);
  /** The group each conversation shows in (its family's). */
  const shownIn = new Map(sections.flatMap((s) => s.conversations.map((c) => [c.id, s.group?.id ?? null] as const)));

  /** The server moves the conversation's whole family; so does the sidebar until it hears back. */
  const move = async (convId: string, groupId: string | null) => {
    if (!shownIn.has(convId) || shownIn.get(convId) === groupId) return;
    const before = moves;
    const { ids } = moveFamily(before, conversations, convId, groupId);
    setMoves((m) => moveFamily(m, conversations, convId, groupId).moves);
    try {
      await api.moveToGroup(convId, groupId);
    } catch (e) {
      setMoves((m) => undoMoves(m, ids, before));
      alert(t.sidebar.moveFailed((e as Error).message));
    }
    onChanged();
  };

  const rename = async (group: ConversationGroup, name: string) => {
    try {
      await api.renameGroup(group.id, name);
    } catch (e) {
      return (e as Error).message;
    }
    setRenaming(null);
    onChanged();
  };

  const remove = async (group: ConversationGroup) => {
    if (!confirm(t.sidebar.confirmDeleteGroup(group.name))) return;
    try {
      await api.deleteGroup(group.id);
    } catch (e) {
      alert(t.sidebar.deleteGroupFailed((e as Error).message));
    }
    onChanged();
  };

  const dropProps = (section: GroupSection) => {
    const key = sectionKey(section);
    const carries = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
    return {
      onDragOver: (e: DragEvent) => {
        if (!carries(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (over !== key) setOver(key);
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((k) => (k === key ? null : k));
      },
      onDrop: (e: DragEvent) => {
        if (!carries(e)) return;
        e.preventDefault();
        setOver(null);
        setDragging(null);
        void move(e.dataTransfer.getData(DRAG_TYPE), section.group?.id ?? null);
      },
    };
  };

  const empty = !conversations.length && !groups.length;
  /** The family being dragged: it moves as one. */
  const draggingFamily = new Set(dragging ? familyIds(conversations, dragging) : []);
  const sizes = familySizes(conversations);

  /** The button that shows or hides what was branched from a conversation, with how many there are. */
  const foldButton = (node: ConvNode) => {
    if (!node.children.length) return null;
    const below = descendants(node);
    const hidden = folded.has(node.id);
    const status = hidden ? groupStatus(below, seen) : undefined;
    const action = hidden ? t.sidebar.showBranches(below.length) : t.sidebar.hideBranches(below.length);
    // The dot is a picture: its meaning is said in words too.
    const label = status ? `${action} · ${t.sidebar.status[status]}` : action;
    return (
      <button
        type="button"
        className={`conv-fold ${hidden ? '' : 'open'}`}
        aria-expanded={!hidden}
        aria-label={label}
        title={label}
        onClick={() => fold(node.id)}
      >
        <BranchIcon size={12} />
        <span className="conv-fold-count">{below.length}</span>
        {status && <span className={`status-dot ${status}`} aria-hidden />}
      </button>
    );
  };

  const conversationRow = (c: ConversationSummary, node: ConvNode, section: GroupSection, depth: number) => {
    const active = route.page === 'chat' && route.id === c.id;
    const s = convStatus(c, seen[c.id]);
    const current = section.group?.id ?? null;
    const moveLabel = (sizes.get(c.id) ?? 1) > 1 ? t.sidebar.moveFamilyTo(c.title) : t.sidebar.moveTo(c.title);
    return (
      <div
        className={`conv-item ${active ? 'active' : ''} ${draggingFamily.has(c.id) ? 'dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, c.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(c.id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
      >
        <a href={`#/c/${c.id}`} className="conv-link" draggable={false}>
          <span className="conv-title">
            {/* Indented no further: it says it is a branch of the one above it. */}
            {depth > MAX_INDENT && (
              <span className="conv-deep" aria-hidden>
                ↳
              </span>
            )}
            {s && <span className={`status-dot ${s}`} aria-hidden />}
            {/* Its own element: the text of a flex row cannot end in an ellipsis. */}
            <span className="conv-title-text">{c.title}</span>
          </span>
          <span className="conv-meta">
            <MemberDots agents={c.agents} className="conv-dots" />
            {s && <span className={`conv-status ${s}`}>{t.sidebar.status[s]}</span>}
            {c.sorting && <span className="conv-sorting">{t.sidebar.sorting}</span>}
            {c.schedule && (c.schedule.enabled || scheduleTrouble(c.schedule)) && (
              <span
                className={`conv-schedule ${scheduleTrouble(c.schedule) ? 'warn' : ''}`}
                title={sidebarScheduleTitle(c.schedule, t, lang)}
                role="img"
                aria-label={sidebarScheduleTitle(c.schedule, t, lang)}
              >
                <ClockIcon size={12} />
              </span>
            )}
            {relativeTime(c.updatedAt, t)}
          </span>
        </a>
        {foldButton(node)}
        {groups.length > 0 && (
          // A native menu: works with the keyboard and on touch screens, where dragging does not.
          <span className="icon-button conv-move" title={moveLabel}>
            <FolderIcon size={15} />
            <select value={current ?? ''} aria-label={moveLabel} onChange={(e) => void move(c.id, e.target.value || null)}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value="">{t.sidebar.otherGroup}</option>
            </select>
          </span>
        )}
        <button className="icon-button conv-delete" aria-label={t.sidebar.deleteConversation} onClick={() => onDelete(c)}>
          ×
        </button>
      </div>
    );
  };

  /** A deleted conversation the ones under it were branched from: only its title, which links nowhere. */
  const deletedRow = (node: ConvNode) => (
    <div className="conv-item conv-gone" title={t.message.branchGoneTitle}>
      <span className="conv-link">
        <span className="conv-title">
          <span className="conv-title-text">{node.title ? `${node.title}${t.message.branchGone}` : t.sidebar.deletedChat}</span>
        </span>
      </span>
      {foldButton(node)}
    </div>
  );

  const renderNode = (node: ConvNode, section: GroupSection, depth = 0): ReactNode => (
    <div key={node.id} className="conv-node">
      {node.conv ? conversationRow(node.conv, node, section, depth) : deletedRow(node)}
      {node.children.length > 0 && !folded.has(node.id) && (
        <div className={`conv-children ${depth >= MAX_INDENT ? 'flat' : ''}`}>
          {node.children.map((child) => renderNode(child, section, depth + 1))}
        </div>
      )}
    </div>
  );

  return (
    <>
      {empty && <p className="muted small pad">{t.sidebar.empty}</p>}
      {!empty &&
        sections.map((section) => {
          const key = sectionKey(section);
          const { group } = section;
          const name = group?.name ?? t.sidebar.otherGroup;
          const isCollapsed = collapsed.has(key);
          const status = isCollapsed ? groupStatus(section.conversations, seen) : undefined;
          return (
            <section key={key} className={`conv-group ${over === key ? 'drop-over' : ''}`} aria-label={name} {...dropProps(section)}>
              {group && renaming === group.id ? (
                <GroupNameField initial={group.name} onSave={(n) => rename(group, n)} onCancel={() => setRenaming(null)} />
              ) : (
                <div className="group-head">
                  <button type="button" className="group-toggle" aria-expanded={!isCollapsed} onClick={() => toggle(key)}>
                    <span className={`group-chevron ${isCollapsed ? '' : 'open'}`}>
                      <ChevronIcon size={14} />
                    </span>
                    <span className="group-name">{name}</span>
                    <span className="group-count">{section.conversations.length}</span>
                    {status && <span className={`status-dot ${status}`} title={t.sidebar.status[status]} />}
                  </button>
                  {group && (
                    <>
                      <button
                        type="button"
                        className="icon-button group-action"
                        onClick={() => setRenaming(group.id)}
                        aria-label={t.sidebar.renameGroup}
                        title={t.sidebar.renameGroup}
                      >
                        <PencilIcon size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button group-action danger"
                        onClick={() => remove(group)}
                        aria-label={t.sidebar.deleteGroup}
                        title={t.sidebar.deleteGroup}
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              )}
              {!isCollapsed &&
                (section.trees.length ? (
                  section.trees.map((tree) => renderNode(tree, section))
                ) : (
                  <p className="group-empty">{t.sidebar.dropHere}</p>
                ))}
            </section>
          );
        })}
    </>
  );
}
