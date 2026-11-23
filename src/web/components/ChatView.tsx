import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from 'react';
import {
  PROVIDER_LABEL,
  TEAM_WORKTREE,
  cwdsOf,
  pendingPlan,
  permissionLevel,
  PREVIEW_NOT_READY,
  type AppPreviewRequest,
  type ApprovalAnswer,
  type ChatMessage,
  type Conversation,
  type ConversationBranch,
  type ConversationSummary,
  type LeadAgentSettings,
  type ProviderModels,
  type ProviderStatus,
  type ScheduleProposal,
  type ServerEvent,
} from '../../shared/types';
import { api, ApiError, orCreateCwd, type AttachmentUpload } from '../api';
import {
  DealtReplies,
  filePreviewTarget,
  finishedReplies,
  localPage,
  opensByItself,
  PREVIEW_WIDTH_KEY,
  previewSuggestion,
  shownApp,
  startsByItself,
  storedPreviewWidth,
  type PreviewSelection,
  type PreviewSuggestion,
} from '../appPreview';
import { highlightsByReply, nextReviewStart } from '../../shared/review';
import { checksHold, latestChecks } from '../../shared/checks';
import { askingReplies } from '../../shared/ask';
import { stepsOfMessage } from '../../shared/steps';
import {
  afterStreamError,
  applyStates as findApplyStates,
  branchSource,
  draftStatus,
  followsAfterScroll,
  isTeamResult,
  savesSwitchesAlone,
  scrollSpot,
  showsToEnd,
  teamToEdit,
  savedCommandsKey,
} from '../chat';
import { useI18n, useT } from '../i18n';
import { refreshLimits, useLimits } from '../limits';
import { hashFor } from '../route';
import {
  describeRepeat,
  handedHook,
  proposalDraft,
  scheduleBadgeTitle,
  scheduleState,
  scheduleTrouble,
  type ScheduleDraft,
} from '../schedule';
import { PROVIDER_COLOR, initials, leadLabel, modelSummary } from '../util';
import { DiffView } from './ChangesCard';
import { Composer } from './Composer';
import { Deferred, lazyPart } from './Deferred';
import { ArrowDownIcon, BranchIcon, ClockIcon, FolderIcon, MoreIcon, PreviewIcon, ShareIcon, UsersIcon } from './icons';
import { MessageItem } from './MessageItem';
import { QueueTray } from './QueueTray';
import { RoleText } from './RoleText';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';
import { TeamReviser } from './TeamReviser';
import { useDialog } from './useDialog';

// Loaded when first opened, not with the chat: the file browser, the schedule and sharing.
const AppPreview = lazyPart(() => import('./AppPreview').then((m) => m.AppPreview));
const FileBrowser = lazyPart(() => import('./FileBrowser').then((m) => m.FileBrowser));
const ScheduleDrawer = lazyPart(() => import('./ScheduleDrawer').then((m) => m.ScheduleDrawer));
const ShareDialog = lazyPart(() => import('./ShareDialog').then((m) => m.ShareDialog));

/** How long to wait before reconnecting when the browser gave up on the event stream. */
const RECONNECT_MS = 3000;

interface State {
  conv: Conversation | null;
  running: boolean;
  active: string[];
}

function upsert(messages: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((x) => x.id === m.id);
  if (i < 0) return [...messages, m];
  const next = [...messages];
  next[i] = m;
  return next;
}

function reducer(s: State, e: ServerEvent): State {
  if (e.type === 'snapshot') return { conv: e.conversation, running: e.running, active: e.activeAgentIds };
  if (e.type === 'status') return { ...s, running: e.running, active: e.activeAgentIds };
  if (!s.conv) return s;
  switch (e.type) {
    case 'message':
      return { ...s, conv: { ...s.conv, messages: upsert(s.conv.messages, e.message) } };
    case 'delta': {
      const msg = s.conv.messages.find((m) => m.id === e.messageId);
      if (!msg) return s;
      const parts = [...msg.parts];
      const cur = parts[e.partIndex];
      parts[e.partIndex] =
        cur?.type === 'text' || cur?.type === 'thinking' ? { ...cur, text: cur.text + e.text } : { type: 'text', text: e.text };
      return { ...s, conv: { ...s.conv, messages: upsert(s.conv.messages, { ...msg, parts }) } };
    }
    case 'queue':
      return { ...s, conv: { ...s.conv, queue: e.queue } };
    case 'conversation':
      return {
        ...s,
        conv: {
          ...s.conv,
          title: e.title,
          agents: e.agents,
          settings: e.settings,
          worktrees: e.worktrees,
          pause: e.pause,
          schedule: e.schedule,
        },
      };
  }
  return s;
}

/** The app the team made, as the server found it runs. */
type PreviewReady = PreviewSuggestion & { request: AppPreviewRequest & { entry: string }; shown: string };

interface Props {
  id: string;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  /** The sidebar's conversations (undefined until loaded): a branch names the one it comes from by its title now. */
  conversations?: ConversationSummary[];
  onChanged: () => void;
}

export function ChatView({ id, providers, catalog, conversations, onChanged }: Props) {
  const { t, lang } = useI18n();
  const [state, dispatch] = useReducer(reducer, { conv: null, running: false, active: [] });
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  /** The conversation is gone (deleted): stop reconnecting. */
  const [gone, setGone] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  // Open at once for a webhook New automation made with it: the drawer shows its token, once.
  const [scheduleOpen, setScheduleOpen] = useState(() => handedHook(id) !== undefined);
  /** A schedule a reply proposed, opened in the schedule drawer to be changed before saving it. */
  const [proposalForm, setProposalForm] = useState<{ messageId: string; draft: ScheduleDraft }>();
  const [appPreview, setAppPreview] = useState<PreviewSelection | null>(null);
  // Hidden by the header's Preview button: it keeps running until it is closed.
  const [previewHidden, setPreviewHidden] = useState(false);
  const openFilePreview = useCallback((target: PreviewSelection) => {
    setFilesOpen(false);
    setPreviewHidden(false);
    setAppPreview(target);
  }, []);
  const openReplyPreview = useCallback((messageId: string, agentName: string, path: string) => {
    const request = filePreviewTarget(path);
    if (!request) return;
    setPreviewHidden(false);
    setAppPreview({ request: { ...request, messageId }, label: '@' + agentName, agentName });
  }, []);
  // The width the divider was dragged to, on this browser.
  const [previewWidth, setPreviewWidth] = useState<number | undefined>(() => {
    try {
      return storedPreviewWidth(localStorage.getItem(PREVIEW_WIDTH_KEY));
    } catch {
      return undefined;
    }
  });
  const resizePreview = useCallback((width: number | undefined, final: boolean) => {
    setPreviewWidth(width);
    if (!final) return;
    try {
      if (width === undefined) localStorage.removeItem(PREVIEW_WIDTH_KEY);
      else localStorage.setItem(PREVIEW_WIDTH_KEY, String(width));
    } catch {
      /* no storage: for this page only */
    }
  }, []);
  const [filesOpen, setFilesOpen] = useState(false);
  /** The share dialog is open: for the whole conversation, or up to and including one reply (`upTo`). */
  const [share, setShare] = useState<{ upTo?: string } | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [diff, setDiff] = useState<{ title: string; load: () => Promise<string> } | null>(null);
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  /** A withdrawn message's text, going back into the composer to be edited. */
  const [restore, setRestore] = useState<{ text: string; once?: boolean }>();
  const scroller = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  // The team row fades out on the right while more chips are hidden there.
  const [moreChips, setMoreChips] = useState(false);
  useEffect(() => {
    const row = chipsRef.current;
    if (!row) return;
    const check = () => setMoreChips(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    row.addEventListener('scroll', check, { passive: true });
    return () => {
      observer.disconnect();
      row.removeEventListener('scroll', check);
    };
  }, [state.conv?.agents.length]);

  // Keep whoever is speaking visible in the team row (it scrolls when the team is large).
  useEffect(() => {
    const row = chipsRef.current;
    const chip = row?.querySelector<HTMLElement>('.team-chip.speaking');
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({ left: chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
  }, [state.active]);

  // On phones the header's actions are a menu under ⋯ (.more-button in styles.css); wider screens
  // show them in a row and never open it.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const moreRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const menuTimer = useRef<number | undefined>(undefined);
  /** Closes the menu; with `refocus`, focus goes to ⋯ (the menu's buttons are about to be hidden). */
  const closeMenu = useCallback((refocus: boolean) => {
    window.clearTimeout(menuTimer.current);
    if (refocus) moreRef.current?.focus();
    setMenuOpen(false);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    // A tap or Tab elsewhere closes it, and focus stays where it went. Focus outside the app is
    // left alone: copying over plain http focuses a textarea put in <body> for a moment (copy.ts).
    const app = document.getElementById('root');
    const onOutside = (e: Event) => {
      const target = e.target as Node;
      if (e.type === 'focusin' && !app?.contains(target)) return;
      if (!moreRef.current?.contains(target) && !actionsRef.current?.contains(target)) closeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeMenu(true);
    };
    // Same width as the @media rule that makes it a menu: past it the row is shown instead.
    const phone = window.matchMedia('(max-width: 560px)');
    const onWidth = () => closeMenu(false);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    document.addEventListener('keydown', onKey);
    phone.addEventListener('change', onWidth);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
      document.removeEventListener('keydown', onKey);
      phone.removeEventListener('change', onWidth);
    };
  }, [menuOpen, closeMenu]);
  useEffect(() => () => window.clearTimeout(menuTimer.current), []);
  /**
   * Opens a drawer from the header. From the menu, focus moves to ⋯ first: the drawer gives focus
   * back on close to whatever had it, and the button that was clicked is hidden by then.
   */
  const openFromHead = (open: (value: boolean) => void) => () => {
    if (menuOpen) closeMenu(true);
    open(true);
  };

  /** The messages follow new output (see `followsAfterScroll`). */
  const stick = useRef(true);
  /** Where the messages stood last, to tell the reader scrolling up or down from more coming in. */
  const lastSpot = useRef({ top: 0, distance: 0 });
  /** The button above the message box that takes the messages to their end shows (see `showsToEnd`). */
  const [behind, setBehind] = useState(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    let es: EventSource;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      if (closed) return;
      es?.close();
      window.clearTimeout(timer);
      timer = undefined;
      setConnected(false);
      const source = new EventSource(api.eventsUrl(id));
      es = source;
      source.onmessage = (ev) => {
        if (closed || source !== es) return;
        const e = JSON.parse(ev.data) as ServerEvent;
        if (e.type === 'snapshot') setConnected(true);
        dispatch(e);
        if (e.type === 'status' || e.type === 'conversation') onChangedRef.current();
      };
      source.onopen = () => {
        // Connected again after a restart, the server may have other limits (Restart server…).
        refreshLimits();
      };
      source.onerror = () => {
        if (closed || source !== es) return;
        setConnected(false);
        // Only a 404 means the conversation is gone; anything else (e.g. the server restarting) is retried.
        const decide = (err: unknown) => {
          if (closed || source !== es) return;
          const next = afterStreamError(err, source.readyState === EventSource.CLOSED);
          if (next === 'stop') {
            source.close();
            closed = true;
            setGone(true);
            setError((err as Error).message);
          } else if (next === 'reconnect' && timer === undefined) {
            timer = window.setTimeout(() => {
              timer = undefined;
              if (!closed) connect();
            }, RECONNECT_MS);
          }
        };
        api.getConversation(id).then(() => decide(undefined), decide);
      };
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') connect();
      else setConnected(false);
    };
    const offline = () => {
      es.close();
      window.clearTimeout(timer);
      timer = undefined;
      setConnected(false);
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) connect();
    };
    connect();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', connect);
    window.addEventListener('offline', offline);
    window.addEventListener('pageshow', restored);
    window.addEventListener('relay:refresh-chat', connect);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', connect);
      window.removeEventListener('offline', offline);
      window.removeEventListener('pageshow', restored);
      window.removeEventListener('relay:refresh-chat', connect);
      closed = true;
      window.clearTimeout(timer);
      es.close();
    };
  }, [id]);

  // Who designs the team, for auto-team conversations.
  const autoTeam = Boolean(state.conv?.settings.autoTeam);
  useEffect(() => {
    if (autoTeam)
      api.getSettings().then(
        (s) => setLead(s.lead),
        () => {},
      );
  }, [autoTeam]);

  /**
   * Notes where the messages stand. While they follow, the browser must not move them itself when
   * something above shrinks (scroll anchoring): that would read as the reader scrolling up. Once they
   * stop, anchoring keeps the reader's place as content above changes.
   */
  const settle = (el: HTMLElement) => {
    lastSpot.current = scrollSpot(el);
    el.style.overflowAnchor = stick.current ? 'none' : '';
    setBehind(showsToEnd(stick.current, lastSpot.current));
  };
  /** Stop following: the reader is about to look at something else in the messages. */
  const stopFollowing = () => {
    stick.current = false;
    if (scroller.current) settle(scroller.current);
  };
  /**
   * The button above the message box: to the end of the messages, following new output again from now
   * (a scroll down never stops it). A mouse or a finger never focuses it (its `onMouseDown`), so what
   * was being typed keeps the focus, and a phone's keyboard stays as it was. Focused, it was reached
   * from the keyboard or a screen reader: focus goes on to the message box, as the button is gone once
   * the messages follow.
   */
  const toEnd = (e: MouseEvent<HTMLButtonElement>) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' });
    settle(el);
    if (document.activeElement === e.currentTarget) {
      chatRef.current?.querySelector<HTMLTextAreaElement>('.composer-row textarea')?.focus({ preventScroll: true });
    }
  };

  // Follow the stream unless the user scrolled up to read. It follows when the messages change size (a
  // reply streaming, an image loading, the message box growing), at that moment, and never on a render
  // that changes nothing: the sidebar's list, fetched every few seconds, used to pull a reader down then.
  const loaded = state.conv !== null;
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const follow = () => {
      // A scroll whose event has not come yet (the reader's, or a message scrolled into view) counts first.
      stick.current = followsAfterScroll(stick.current, lastSpot.current, el);
      if (stick.current) el.scrollTop = el.scrollHeight;
      settle(el);
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [loaded]);

  // Read through a ref so the callbacks stay stable while messages stream (MessageItem is memoised).
  const convRef = useRef(state.conv);
  convRef.current = state.conv;
  const tRef = useRef(t);
  tRef.current = t;

  const onDiff = useCallback((msg: ChatMessage, scope: 'turn' | 'agent') => {
    const c = convRef.current;
    if (!c) return;
    const name = msg.agentName ?? 'agent';
    if (scope === 'turn') setDiff({ title: tRef.current.chat.turnDiffTitle(name), load: () => api.messageDiff(c.id, msg.id) });
    else if (isTeamResult(msg.changes)) {
      // Made in the team's own worktrees: the team's result, whoever wrote this turn.
      setDiff({ title: tRef.current.chat.teamDiffTitle, load: () => api.agentDiff(c.id, TEAM_WORKTREE) });
    } else if (msg.author.kind === 'agent') {
      const agentId = msg.author.agentId;
      setDiff({ title: tRef.current.chat.agentDiffTitle(name), load: () => api.agentDiff(c.id, agentId) });
    }
  }, []);

  const onApply = useCallback(async (agentId: string) => {
    const c = convRef.current;
    if (!c) return;
    try {
      await api.applyAgent(c.id, agentId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onResend = useCallback(async (messageId: string, text: string) => {
    const c = convRef.current;
    if (!c) return false;
    const index = c.messages.findIndex((m) => m.id === messageId);
    const changed = c.messages.slice(index + 1).filter((m) => m.changes?.some((c) => c.files.length > 0)).length;
    if (changed > 0 && !confirm(tRef.current.chat.resendConfirm(changed))) return false;
    try {
      setError('');
      stick.current = true;
      await api.resend(c.id, messageId, text);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);

  const onConfirmPlan = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (!c) return;
    try {
      setError('');
      await api.confirmPlan(c.id, messageId);
      onChangedRef.current(); // the sidebar stops asking
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onDeclinePlan = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (!c) return;
    try {
      setError('');
      await api.declinePlan(c.id, messageId);
      onChangedRef.current(); // the sidebar stops asking
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onSavePlan = useCallback(async (messageId: string, name: string) => {
    const c = convRef.current;
    if (!c) return;
    try {
      await api.savePlan(c.id, messageId, name);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onAdjustTeam = useCallback(() => setTeamOpen(true), []);

  const onEditProposal = useCallback((messageId: string, proposal: ScheduleProposal) => {
    setProposalForm({ messageId, draft: proposalDraft(proposal, Date.now()) });
    setScheduleOpen(true);
  }, []);

  const retrying = useRef(false);
  const onRetry = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (!c || retrying.current) return; // a double click would get "busy" for the second request
    const later = c.messages.slice(c.messages.findIndex((m) => m.id === messageId) + 1);
    const changed = later.filter((m) => m.changes?.some((c) => c.files.length > 0)).length;
    if (later.length > 0 && !confirm(tRef.current.chat.retryConfirm(later.length, changed))) return;
    retrying.current = true;
    try {
      setError('');
      stick.current = true;
      await api.retry(c.id, messageId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      retrying.current = false;
    }
  }, []);

  const onShare = useCallback((messageId: string) => setShare({ upTo: messageId }), []);

  // A new conversation with the messages up to and including this reply, opened at once.
  const branching = useRef(false);
  const onBranch = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (!c || branching.current) return;
    branching.current = true;
    try {
      setError('');
      const branch = await api.branch(c.id, messageId);
      onChangedRef.current();
      window.location.hash = hashFor({ page: 'chat', id: branch.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      branching.current = false;
    }
  }, []);

  // Continue: the team goes on without the answer an agent asked for.

  const onSkipQuestion = useCallback(() => {
    const c = convRef.current;
    if (!c) return;
    setError('');
    api.send(c.id, '', []).catch((e: Error) => setError(e.message));
  }, []);

  const onApproval = useCallback(async (approvalId: string, answer: ApprovalAnswer) => {
    const c = convRef.current;
    if (!c) return;
    try {
      await api.answerApproval(c.id, approvalId, answer);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        window.dispatchEvent(new Event('relay:refresh-chat'));
        return;
      }
      setError((e as Error).message);
    }
  }, []);

  // Only each agent's (or the team's) latest result from its current worktree can be applied.
  const messages = state.conv?.messages;
  const worktrees = state.conv?.worktrees;
  const applyStates = useMemo(() => findApplyStates(messages ?? [], worktrees ?? {}), [messages, worktrees]);
  // A string, so that it changes only when a card saves a command: a proposed schedule reads the commands again then.
  const commandsKey = useMemo(() => savedCommandsKey(messages ?? []), [messages]);

  // Stable while messages stream, so MessageItem (memoised) only re-renders the message that changed.
  const agents = state.conv?.agents;
  const mentionNames = useMemo(() => (agents ?? []).map((a) => a.name), [agents]);

  // What the lead agent's reviews point out, by reply: worked out again only when a review is added
  // or goes (a ready review never changes), so a reply's marks keep their identity while others stream.
  const reviewIds = (messages ?? []).flatMap((m) => (m.review?.status === 'ready' ? [m.id] : [])).join(' ');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the review ids say when `messages` matters
  const marks = useMemo(() => highlightsByReply(messages ?? []), [reviewIds]);

  // A next step the lead agent suggests goes in the message box, ahead of anything typed there.
  const onUseStep = useCallback((text: string) => setRestore({ text, once: true }), []);

  // Lead review on or off, from the latest team design card (the conversation event brings the setting).
  const onLeadReview = useCallback(async (on: boolean) => {
    const c = convRef.current;
    if (!c) return false;
    setError('');
    try {
      await api.setLeadReview(c.id, on);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);

  // Team checks: the latest result's card. Errors show on the card itself (it rethrows them).
  const onRecheckChecks = useCallback(async (messageId: string, confirm?: boolean) => {
    const c = convRef.current;
    if (c) await api.recheckChecks(c.id, messageId, confirm);
  }, []);
  const onSkipChecks = useCallback(async (messageId: string) => {
    const c = convRef.current;
    if (c) await api.skipChecks(c.id, messageId);
  }, []);
  const onApplyAnyway = useCallback(async (agentId: string, how: 'force' | 'confirm') => {
    const c = convRef.current;
    if (c) await api.applyAgent(c.id, agentId, how === 'force' ? { force: true } : { confirm: true });
  }, []);
  const onFixChecks = useCallback(async (messageId: string, agentId: string) => {
    const c = convRef.current;
    if (!c) return;
    stick.current = true;
    await api.fixChecks(c.id, messageId, agentId);
  }, []);

  // The app the team made last (see `previewSuggestion`), once the server says it runs: the card,
  // the header's button, and the panel opening by itself.
  const suggestion = useMemo(() => (state.conv ? previewSuggestion(state.conv.messages) : undefined), [state.conv]);
  const [ready, setReady] = useState<PreviewReady>();
  /** The app the team just made cannot run in a preview: why (the server's sentence), and who made it. */
  const [notReady, setNotReady] = useState<PreviewSuggestion & { problem: string }>();
  const previewOpen = useRef(false);
  previewOpen.current = appPreview !== null;
  const latest = useRef(state.conv);
  latest.current = state.conv;
  /** The finished replies the page has dealt with (see `DealtReplies`). */
  const handled = useRef<DealtReplies | undefined>(undefined);
  /** The folders opened by themselves already: each app opens once by itself. */
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (state.conv && !handled.current) handled.current = new DealtReplies(finishedReplies(state.conv.messages));
  }, [state.conv]);
  const finished = state.conv ? finishedReplies(state.conv.messages).length : 0;
  // Looked up again after every finished reply: the next turn may add what this one lacked (a lockfile).
  const lookKey = state.conv && suggestion ? `${state.conv.id}\0${suggestion.messageId}\0${suggestion.path ?? ''}\0${finished}` : '';
  useEffect(() => {
    const c = latest.current;
    if (!c || !suggestion) {
      setReady(undefined);
      setNotReady(undefined);
      return;
    }
    const fresh = handled.current?.fresh(suggestion.messageId) ?? false;
    // The replies there now: dealt with once this lookup ends (a newer one gets a lookup of its own).
    const there = finishedReplies(c.messages);
    const messageId = suggestion.messageId;
    const link = suggestion.path !== undefined ? filePreviewTarget(suggestion.path) : undefined;
    const lookup = new AbortController();
    type Found = { folder: string; mode: AppPreviewRequest['mode']; entry: string; shown: string };
    const byChanges = (): Promise<Found> => api.appPreviewChanged(c.id, messageId, lookup.signal);
    // A link's folder as written (the server's path is the real one, which a symlinked working
    // directory does not start), or where the app is in its working directory.
    const byLink = (): Promise<Found> =>
      api.appPreviewTarget(c.id, { ...link!, messageId }, lookup.signal).then((resolved) => ({
        ...resolved,
        shown: !/^(?:[a-z]:)?[\\/]/i.test(link!.folder)
          ? [link!.folder, resolved.entry].filter(Boolean).join('/')
          : shownApp(resolved.folder, resolved.entry, cwdsOf(c.settings)),
      }));
    // A link that leads nowhere runnable: the app its turn changed, if any.
    const found = link
      ? byLink().catch((error) => (suggestion.changed && !lookup.signal.aborted ? byChanges() : Promise.reject(error)))
      : byChanges();
    const dealt = () => handled.current?.dealt(there);
    found.then(
      (resolved) => {
        if (lookup.signal.aborted) return;
        const request = { mode: resolved.mode, folder: resolved.folder, entry: resolved.entry, messageId };
        setReady({ ...suggestion, request, shown: resolved.shown });
        setNotReady(undefined);
        const opens = opensByItself(
          { changed: suggestion.changed, fresh, folder: resolved.folder },
          {
            opened: autoOpened.current,
            panelOpen: previewOpen.current,
            narrow: matchMedia('(max-width: 1100px)').matches,
            local: localPage(location.hostname),
          },
        );
        dealt();
        if (!opens) return;
        autoOpened.current.add(resolved.folder);
        setPreviewHidden(false);
        setAppPreview({
          request,
          label: '@' + suggestion.agentName,
          agentName: suggestion.agentName,
          auto: true,
          autoStart: startsByItself(resolved.mode, c.settings.permission),
          permission: c.settings.permission,
        });
      },
      (error: unknown) => {
        if (lookup.signal.aborted) return;
        // Nothing that runs there (yet): nothing in the header; a card says why when the team just made an app.
        setReady(undefined);
        setNotReady(error instanceof ApiError && error.code === PREVIEW_NOT_READY ? { ...suggestion, problem: error.message } : undefined);
        dealt();
      },
    );
    return () => lookup.abort();
    // The key says when to look again; the reply it names is read through `latest`.
  }, [lookKey]);
  const openReady = useCallback(() => {
    if (!ready) return;
    setPreviewHidden(false);
    setAppPreview({ request: ready.request, label: '@' + ready.agentName, agentName: ready.agentName });
  }, [ready]);

  const { conv, running, active } = state;
  if (!conv) return <div className="page-center muted">{error || t.common.loading}</div>;

  // Approval requests still waiting for an answer (only while the agent's turn is running), but those
  // the lead agent still reviews ("Approve for me"): they wait for nobody yet. And the browser handed to
  // the user (`browser_hand_over`), waiting for them to take it over.
  const pending = conv.messages.flatMap((m) =>
    m.status === 'streaming'
      ? m.parts.flatMap((p) =>
          p.type === 'approval' && p.status === 'pending' && p.review?.status !== 'reviewing'
            ? [{ anchor: `approval-${p.id}`, agent: m.agentName ?? 'agent', handover: false }]
            : p.type === 'handover' && p.status === 'pending'
              ? [{ anchor: `handover-${p.id}`, agent: m.agentName ?? 'agent', handover: true }]
              : [],
        )
      : [],
  );
  const hasUserMessage = conv.messages.some((m) => m.author.kind === 'user');
  const waitingForTeam = autoTeam && conv.agents.length === 0;
  // The lead agent's team design waits for the user: once they confirm it, the team answers.
  const awaitingConfirm = Boolean(pendingPlan(conv.messages));
  // The lead agent is designing the team: what the user sends meanwhile waits for the confirmed team.
  const designing = running && conv.messages.some((m) => m.plan?.status === 'planning' && m.status === 'streaming');
  // The lead agent is reviewing the team's replies: what the user sends meanwhile stops the review and goes now.
  const reviewing = running && conv.messages.some((m) => m.review?.status === 'reviewing' && m.status === 'streaming');
  // Where the next review would start reading: a stopped or failed review card before it says its
  // replies are read then, the others nothing of a next review.
  const nextReview = conv.messages.some((m) => m.review && m.review.status !== 'ready') ? nextReviewStart(conv.messages) : Infinity;
  const latestPlanId = conv.messages.findLast((m) => m.plan?.status === 'ready')?.id;
  const latestChecksId = latestChecks(conv.messages)?.id;
  // Team checks that did not pass hold what the user wrote meanwhile, until they decide.
  const checksHeld = !running && Boolean(checksHold(conv.messages)) && (conv.queue ?? []).some((m) => !m.scheduled);
  const leadText = leadLabel(lead ?? { provider: 'claude' });
  // An agent asked the user something and the team waits: its latest questions, and who asked.
  const lastUser = conv.messages.findLastIndex((m) => m.author.kind === 'user');
  const questions = running ? [] : askingReplies(conv.messages, conv.pause);
  // Still waited for while the team replies to another card's answer: answered once that is over.
  const answerLaterIds = new Set(running ? askingReplies(conv.messages, conv.pause).map((m) => m.id) : []);
  // Each of them gave the user steps to take (a steps card), and asked nothing else.
  const stepsOnly = questions.length > 0 && questions.every((m) => stepsOfMessage(m));
  // The team has answered, and made or pointed at an app since the user last wrote.
  const readyCard = !running && ready !== undefined && ready.index > lastUser;
  // The team checks' card says it already, with its own Fix, when they check the app preview.
  const notReadyCard = !running && !readyCard && notReady !== undefined && notReady.index > lastUser && !conv.settings.checks?.previewApp;
  const previewShown = appPreview !== null && !previewHidden;
  const askIds = new Set(questions.map((m) => m.id));
  const askers = questions.map((m) => `@${m.agentName ?? 'agent'}`).join(t.common.listSeparator);
  /** The agents besides this reply's that wait for an answer too ('' when none). */
  const othersWaiting = (id: string) =>
    questions
      .filter((m) => m.id !== id)
      .map((m) => `@${m.agentName ?? 'agent'}`)
      .join(t.common.listSeparator);

  // An earlier card is history as soon as the next question or design arrives.
  const lastDesignOrQuestion = conv.messages.findLast((m) => m.plan || m.author.kind === 'user');
  const fallback = lastDesignOrQuestion?.plan;
  let fallbackStatus: string | undefined;
  if (fallback?.status === 'ready' && fallback.source === 'fallback' && !fallback.awaitingConfirmation && !fallback.declinedAt) {
    if (pending.length) fallbackStatus = pending.every((p) => p.handover) ? t.browserHandover.banner : t.sidebar.waiting;
    else if (questions.length) fallbackStatus = t.chat.asking(askers);
    else if (reviewing) fallbackStatus = t.review.reviewing(leadText);
    else if (running) fallbackStatus = t.plan.teamWorking;
    else if (fallback.forSchedule) fallbackStatus = conv.schedule ? t.plan.scheduleReady : undefined;
    else fallbackStatus = t.plan.canContinue;
  }

  const send = async (text: string, attachments: AttachmentUpload[], interrupt = false) => {
    setError('');
    try {
      stick.current = true;
      await api.send(conv.id, text, attachments, interrupt);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const withdraw = async (msg: ChatMessage, edit: boolean) => {
    setError('');
    try {
      const taken = await api.withdraw(conv.id, msg.id);
      if (edit) {
        const text = taken.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        setRestore({ text });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rename = async () => {
    const title = prompt(t.chat.renamePrompt, conv.title);
    if (!title?.trim()) return;
    await api.updateConversation(conv.id, { title }).catch((e: Error) => setError(e.message));
  };

  return (
    <div
      className={appPreview && !previewHidden ? 'chat previewing' : 'chat'}
      ref={chatRef}
      style={previewWidth === undefined ? undefined : { ['--preview-width' as string]: `${previewWidth}px` }}
    >
      {/* Wide screens: title over the team, badges and actions on the right. Phones and tablets:
          only the title and actions, plus a warning beside the title for full access; on phones the
          actions are a menu under ⋯ (see .chat-head and .more-button in styles.css). */}
      <header className="chat-head">
        <div className="chat-head-top">
          {/* The title and a branch's "Continued from" share the row by what they need (styles.css). */}
          <div className="chat-title-row">
            <button className="chat-title" onClick={rename} title={t.chat.rename}>
              {conv.title}
            </button>
            {conv.branch && <BranchFrom branch={conv.branch} conversations={conversations} className="head-branch" />}
            {conv.settings.permission === 'full' && (
              <span className="badge danger head-warning" title={t.permissions.full.hint}>
                {t.permissions.full.label}
              </span>
            )}
          </div>
          {/* Phones only; a dot while a schedule is on, as the clock is blue then. */}
          <button
            ref={moreRef}
            type="button"
            className={`ghost small-button more-button ${conv.schedule?.enabled ? 'schedule-on' : ''}`}
            aria-label={t.chat.more}
            title={t.chat.more}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => {
              if (menuOpen) return closeMenu(false);
              window.clearTimeout(menuTimer.current);
              setMenuOpen(true);
            }}
          >
            <MoreIcon size={18} />
          </button>
          <div className={`chat-head-actions ${menuOpen ? 'open' : ''}`} id={menuId} ref={actionsRef}>
            <button
              className="ghost small-button head-button"
              onClick={openFromHead(() => setShare({}))}
              title={t.share.buttonTitle}
              disabled={conv.messages.length === 0}
            >
              <ShareIcon size={16} />
              <span className="button-label">{t.share.button}</span>
            </button>
            <button className="ghost small-button head-button" onClick={openFromHead(setFilesOpen)} title={t.chat.filesTitle}>
              <FolderIcon size={16} />
              <span className="button-label">{t.chat.files}</span>
            </button>
            <button
              className={`ghost small-button head-button ${conv.schedule?.enabled ? 'has-schedule' : ''}`}
              onClick={openFromHead(setScheduleOpen)}
              title={
                conv.schedule
                  ? `${describeRepeat(conv.schedule.repeat, t, lang)} · ${scheduleState(conv.schedule, t, lang)}`
                  : t.schedule.buttonTitle
              }
            >
              <ClockIcon size={16} />
              <span className="button-label">{t.schedule.button}</span>
            </button>
            <button className="ghost small-button head-button" onClick={openFromHead(setTeamOpen)} title={t.chat.teamSettings}>
              <UsersIcon size={16} />
              <span className="button-label">{t.chat.teamSettings}</span>
            </button>
            <button
              className={`ghost small-button head-button preview-head-button ${previewShown ? 'on' : ''}`}
              aria-pressed={previewShown}
              disabled={!appPreview && !ready}
              title={appPreview || ready ? t.appPreview.headTitle : t.appPreview.headNothing}
              onClick={openFromHead(() => {
                if (appPreview) setPreviewHidden((hidden) => !hidden);
                else openReady();
              })}
            >
              <PreviewIcon size={16} />
              <span className="button-label">{t.appPreview.headButton}</span>
            </button>
          </div>
        </div>
        <div className="chat-head-sub">
          {/* One row that scrolls sideways when the team is large (the wheel scrolls it too). */}
          <div
            className={`team-chips ${moreChips ? 'more' : ''}`}
            ref={chipsRef}
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {waitingForTeam && <span className="team-chip auto-chip">✦ {t.chat.autoTeam}</span>}
            {conv.agents.map((a) => (
              <span
                key={a.id}
                className={`team-chip ${active.includes(a.id) ? 'speaking' : ''}`}
                style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}
                title={`${PROVIDER_LABEL[a.provider]}${modelSummary(a, t) ? ` · ${modelSummary(a, t)}` : ''}\n${a.role}`}
              >
                <span className="avatar sm">{initials(a.name)}</span>@{a.name}
              </span>
            ))}
          </div>
          <div className="chat-head-badges">
            {!waitingForTeam && (
              <span className="badge" title={t.modes[conv.settings.mode].hint}>
                {t.modes[conv.settings.mode].label} ·{' '}
                {conv.settings.mode === 'relay' ? t.chat.hops(conv.settings.maxHops) : t.chat.rounds(conv.settings.rounds)}
              </span>
            )}
            <span className={`badge ${conv.settings.permission === 'full' ? 'danger' : ''}`}>
              {t.permissions[permissionLevel(conv.settings)].label}
            </span>
            {conv.schedule && (
              <button
                type="button"
                className={`badge schedule-badge ${scheduleTrouble(conv.schedule) ? 'warn' : ''} ${conv.schedule.enabled ? '' : 'off'}`}
                onClick={() => setScheduleOpen(true)}
                title={scheduleBadgeTitle(conv.schedule, t, lang)}
              >
                <ClockIcon size={12} />
                {/* Cut with an ellipsis when long (a condition can be): the whole of it is in the title. */}
                <span className="schedule-badge-text">
                  {describeRepeat(conv.schedule.repeat, t, lang)}
                  {/* The next time, and how the checks of what it waits for go, are in the title: the header has little room. */}
                  {conv.schedule.repeat.kind === 'event'
                    ? !conv.schedule.enabled && ` · ${t.schedule.paused}`
                    : !(conv.schedule.enabled && conv.schedule.nextRunAt !== undefined) && ` · ${scheduleState(conv.schedule, t, lang)}`}
                </span>
              </button>
            )}
          </div>
        </div>
      </header>

      {!connected && !gone && <div className="banner">{t.chat.reconnecting}</div>}

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = followsAfterScroll(stick.current, lastSpot.current, el);
          settle(el);
        }}
        onClickCapture={(e) => {
          // Opening or folding part of a message (an activity row, Show more) leaves it where the reader
          // is looking: following would scroll what just opened out of view.
          // So does jumping between a reply and the lead agent's review of it.
          if ((e.target as Element).closest('summary, [aria-expanded], [aria-pressed], .review-reply-link, .review-mark-tag'))
            stopFollowing();
        }}
      >
        <div className="messages-inner">
          {conv.messages.length === 0 && conv.agents.length > 0 && <TeamIntro conv={conv} />}
          {conv.messages.map((m, i) => {
            const item = (
              <MessageItem
                key={m.id}
                msg={m}
                convId={conv.id}
                cwd={conv.settings.cwd}
                agents={conv.agents}
                mentionNames={mentionNames}
                showRound={conv.settings.mode !== 'relay' && conv.settings.rounds > 1}
                applyState={running ? undefined : applyStates.get(m.id)}
                running={running}
                onPreview={openReplyPreview}
                onDiff={onDiff}
                onApply={onApply}
                onResend={onResend}
                onConfirmPlan={onConfirmPlan}
                onDeclinePlan={onDeclinePlan}
                latestPlan={m.id === latestPlanId}
                fallbackStatus={m.id === lastDesignOrQuestion?.id ? fallbackStatus : undefined}
                scheduleText={m.plan ? conv.schedule?.text : undefined}
                onSavePlan={onSavePlan}
                onAdjustTeam={onAdjustTeam}
                onApproval={connected ? onApproval : undefined}
                onRetry={onRetry}
                waitingAnswer={askIds.has(m.id)}
                othersWaiting={askIds.has(m.id) ? othersWaiting(m.id) : undefined}
                answerLater={answerLaterIds.has(m.id)}
                onSkipQuestion={onSkipQuestion}
                onShare={onShare}
                onBranch={onBranch}
                marks={marks.get(m.id)}
                onUseStep={onUseStep}
                leadReview={m.plan || m.review ? Boolean(conv.settings.leadReview) : undefined}
                readNext={m.review && m.review.status !== 'ready' ? i > nextReview : undefined}
                onLeadReview={onLeadReview}
                latestChecks={m.checks ? m.id === latestChecksId : undefined}
                onRecheckChecks={onRecheckChecks}
                onSkipChecks={onSkipChecks}
                onFixChecks={onFixChecks}
                onApplyAnyway={onApplyAnyway}
                onEditProposal={onEditProposal}
                hasSchedule={Boolean(conv.schedule)}
                commandsKey={commandsKey}
              />
            );
            // A branch: a line after the messages copied from the conversation it comes from (a shared
            // page skips it: see messageElements).
            return conv.branch?.afterId === m.id ? (
              <Fragment key={m.id}>
                {item}
                <div className="branch-divider">
                  <BranchFrom branch={conv.branch} conversations={conversations} className="branch-divider-label" />
                </div>
              </Fragment>
            ) : (
              item
            );
          })}
          {notReadyCard && notReady && (
            <section className="preview-ready not-ready" aria-label={t.appPreview.notReadyTitle}>
              <span className="preview-ready-icon" aria-hidden="true">
                <PreviewIcon size={22} />
              </span>
              <div className="preview-ready-text">
                <strong>{t.appPreview.notReadyTitle}</strong>
                <span className="muted small">{notReady.problem}</span>
              </div>
              <button
                type="button"
                className="ghost"
                onClick={() => onUseStep(`@${notReady.agentName} ${t.appPreview.notReadyDraft(notReady.problem)}`)}
              >
                {t.appPreview.askFix(notReady.agentName)}
              </button>
            </section>
          )}
          {readyCard && ready && (
            <section className="preview-ready" aria-label={t.appPreview.readyTitle}>
              <span className="preview-ready-icon" aria-hidden="true">
                <PreviewIcon size={22} />
              </span>
              <div className="preview-ready-text">
                <strong>{t.appPreview.readyTitle}</strong>
                <span className="muted small">
                  <code dir="auto">{ready.shown}</code> · @{ready.agentName}
                </span>
              </div>
              <button type="button" className="primary" onClick={openReady}>
                {t.appPreview.open}
              </button>
            </section>
          )}
        </div>
      </div>

      <div className="composer-dock">
        {/* In the middle above the message box, over the messages' last lines (styles.css). */}
        {behind && (
          <button
            type="button"
            className="to-end"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toEnd}
            aria-label={t.chat.toEnd}
            title={t.chat.toEnd}
          >
            <ArrowDownIcon size={18} />
          </button>
        )}
        {pending.length > 0 && (
          <button
            type="button"
            className="approval-banner"
            onClick={() => {
              // Stop following first: another agent's output would pull the list back down mid-scroll.
              stopFollowing();
              document.getElementById(pending[0]!.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            ⏸ {pending.map((p) => `@${p.agent}`).join(t.common.listSeparator)} ·{' '}
            {pending.every((p) => p.handover) ? t.browserHandover.banner : t.approval.waiting}
          </button>
        )}
        {questions.length > 0 && pending.length === 0 && (
          <button
            type="button"
            className="approval-banner"
            onClick={() => {
              stopFollowing();
              document.getElementById(`ask-${questions[0]!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            {stepsOnly ? `☑ ${t.stepCard.banner(askers)}` : `❓ ${t.chat.asking(askers)}`}
          </button>
        )}
        {error && (
          <div className="error-line" role="alert">
            {error}
            <button className="icon-button" onClick={() => setError('')} aria-label={t.common.close}>
              ×
            </button>
          </div>
        )}
        <QueueTray
          queue={conv.queue ?? []}
          state={awaitingConfirm || designing ? 'confirm' : reviewing ? 'review' : running ? 'busy' : checksHeld ? 'checks' : 'stopped'}
          onSendNow={() => send('', [], running)}
          onWithdraw={withdraw}
        />
        <Composer
          agents={conv.agents}
          running={running}
          canContinue={hasUserMessage}
          locked={awaitingConfirm || designing}
          reviewing={reviewing}
          steering={Boolean(conv.settings.steer)}
          skipQuestion={questions.length > 0}
          placeholder={
            designing
              ? t.chat.placeholderDesigning
              : awaitingConfirm
                ? t.chat.placeholderConfirm
                : questions.length > 0
                  ? t.chat.placeholderAnswer(askers)
                  : reviewing
                    ? t.chat.placeholderReviewing
                    : running
                      ? conv.settings.steer
                        ? t.chat.placeholderSteer
                        : t.chat.placeholderBusy
                      : waitingForTeam
                        ? t.chat.placeholderAuto
                        : autoTeam
                          ? t.chat.placeholderNext
                          : conv.settings.mode === 'relay' && conv.agents[0]
                            ? t.chat.placeholderRelay(conv.agents[0].name)
                            : t.chat.placeholder
          }
          onSend={send}
          onStop={() => api.stop(conv.id).catch((e: Error) => setError(e.message))}
          onContinue={() => send('', [])}
          restore={restore}
        />
        <p className="cwd-line muted small" title={cwdsOf(conv.settings).join('\n')}>
          📁 {cwdsOf(conv.settings).join(' · ')}
        </p>
      </div>

      {diff && <DiffModal title={diff.title} load={diff.load} onClose={() => setDiff(null)} />}

      {scheduleOpen && (
        <Deferred
          onClose={() => {
            setScheduleOpen(false);
            setProposalForm(undefined);
          }}
        >
          <ScheduleDrawer
            key={proposalForm?.messageId ?? 'schedule'}
            conv={conv}
            running={running}
            proposal={proposalForm}
            onClose={() => {
              setScheduleOpen(false);
              setProposalForm(undefined);
            }}
            onEditTeam={() => {
              setScheduleOpen(false);
              setProposalForm(undefined);
              setTeamOpen(true);
            }}
          />
        </Deferred>
      )}
      {teamOpen && (
        <TeamDrawer
          conv={conv}
          providers={providers}
          catalog={catalog}
          running={running}
          reviewing={reviewing}
          leadText={leadText}
          onClose={() => setTeamOpen(false)}
          onError={setError}
        />
      )}
      {filesOpen && (
        <Deferred onClose={() => setFilesOpen(false)}>
          <FileBrowser conv={conv} onPreview={openFilePreview} onClose={() => setFilesOpen(false)} />
        </Deferred>
      )}
      {share && (
        <Deferred onClose={() => setShare(null)}>
          <ShareDialog conv={conv} upTo={share.upTo} chat={() => chatRef.current} onClose={() => setShare(null)} />
        </Deferred>
      )}
      {appPreview && (
        <Deferred onClose={() => setAppPreview(null)}>
          <AppPreview
            key={JSON.stringify(appPreview.request)}
            convId={conv.id}
            target={appPreview}
            collapsed={previewHidden}
            onCollapse={setPreviewHidden}
            onResize={resizePreview}
            onClose={() => {
              setAppPreview(null);
              setPreviewHidden(false);
            }}
            onFeedback={onUseStep}
          />
        </Deferred>
      )}
    </div>
  );
}

function DiffModal({ title, load, onClose }: { title: string; load: () => Promise<string>; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);

  useEffect(() => {
    load().then(setText, (e: Error) => setError(e.message));
  }, [load]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        {error ? (
          <p className="error-line">{error}</p>
        ) : text === null ? (
          <p className="muted">{t.common.loading}</p>
        ) : text.trim() ? (
          <DiffView text={text} />
        ) : (
          <p className="muted">{t.chat.noDiff}</p>
        )}
      </div>
    </div>
  );
}

/**
 * "Continued from <the conversation it was branched from>", a link while that conversation is there:
 * after the chat's title, and after the messages copied from it.
 */
function BranchFrom({
  branch,
  conversations,
  className,
}: {
  branch: ConversationBranch;
  conversations?: ConversationSummary[];
  className: string;
}) {
  const t = useT();
  const source = branchSource(branch, conversations);
  return (
    <span className={className}>
      <BranchIcon size={14} />
      <span className="branch-from">{t.message.continuedFrom}</span>
      {source.gone ? (
        <span className="branch-source" title={`${source.title}${t.message.branchGone} · ${t.message.branchGoneTitle}`}>
          {source.title}
          {t.message.branchGone}
        </span>
      ) : (
        <a className="branch-source" href={hashFor({ page: 'chat', id: branch.fromId })} title={source.title}>
          {source.title}
        </a>
      )}
    </span>
  );
}

function TeamIntro({ conv }: { conv: Conversation }) {
  const t = useT();
  return (
    <div className="team-intro">
      <h2>{t.chat.teamReady}</h2>
      <p className="muted">{t.modes[conv.settings.mode].hint}</p>
      <div className="intro-grid">
        {conv.agents.map((a, i) => (
          <div key={a.id} className="intro-card" style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}>
            <div className="intro-head">
              <span className="avatar">{initials(a.name)}</span>
              <div>
                <strong>@{a.name}</strong>
                <div className="muted small">
                  {PROVIDER_LABEL[a.provider]}
                  {modelSummary(a, t) ? ` · ${modelSummary(a, t)}` : ''}
                  {conv.settings.mode === 'relay' && i === 0 ? ` · ${t.chat.leader}` : ''}
                </div>
              </div>
            </div>
            {a.role.trim() ? <RoleText text={a.role.trim()} lines={6} /> : <p className="intro-role">{t.chat.noRole}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamDrawer({
  conv,
  providers,
  catalog,
  running,
  reviewing,
  leadText,
  onClose,
  onError,
}: {
  conv: Conversation;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  running: boolean;
  /** The team has answered and the lead agent reviews its replies. */
  reviewing: boolean;
  leadText: string;
  onClose: () => void;
  onError: (s: string) => void;
}) {
  const { t, lang } = useI18n();
  const { maxTeamAgents } = useLimits();
  // While the lead agent's design waits for confirmation, the drawer edits that design: saving it
  // settles the design with the team as edited.
  const pending = pendingPlan(conv.messages)?.plan;
  const { team: current, proposed } = useMemo(
    () => teamToEdit({ agents: conv.agents, settings: conv.settings }, pending),
    [conv.agents, conv.settings, pending],
  );
  /** The team as it was when the draft was copied from it. */
  const [base, setBase] = useState<Team>(current);
  const [team, setTeam] = useState<Team>(current);
  const [checksEditorVersion, setChecksEditorVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  /** The lead agent is changing the team at the user's request. */
  const [revising, setRevising] = useState(false);
  /** The lead agent writes the team checks (in the editor's advanced settings): Save waits for it. */
  const [checksDrafting, setChecksDrafting] = useState(false);
  // Auto team: there are members to edit once the lead agent has designed a team.
  const members = !conv.settings.autoTeam || current.agents.length > 0;
  const problems = teamProblems(team, t, { members, maxAgents: maxTeamAgents });
  const dialog = useRef<HTMLElement>(null);
  useDialog(dialog, onClose);

  // The team can change while the drawer is open (e.g. the lead agent designs it): follow it until
  // the user edits; after that, saving would overwrite it, so ask to reload first.
  const status = draftStatus(base, team, current);
  // While the team replies, the lead review and steering boxes alone are saved on their own (the rest waits for it).
  const switches = savesSwitchesAlone(base, team, running, proposed);
  const reviewOnly = switches.length > 0;
  const reload = useCallback(() => {
    setBase(current);
    setTeam(current);
    // The checks editor keeps its own text and unfinished rows until the draft is reloaded.
    setChecksEditorVersion((version) => version + 1);
  }, [current]);
  useEffect(() => {
    if (status === 'refresh') reload();
  }, [status, reload]);

  const save = async () => {
    setSaving(true);
    try {
      if (reviewOnly) {
        if (switches.includes('leadReview')) await api.setLeadReview(conv.id, Boolean(team.settings.leadReview));
        if (switches.includes('steer')) await api.setSteer(conv.id, Boolean(team.settings.steer));
        onClose();
        return;
      }
      // While the lead agent has not designed a team yet, only the settings can change.
      const change = members ? { agents: team.agents, settings: team.settings } : { settings: team.settings };
      await orCreateCwd(
        (createCwd) => api.updateConversation(conv.id, { ...change, createCwd }),
        (missing) => confirm(t.chat.confirmCreateCwd(missing)),
      );
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside
        ref={dialog}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t.chat.teamSettings}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{t.chat.teamSettings}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p className="muted small">{t.chat.drawerNote}</p>
        {proposed && <p className="small drawer-pending">{t.chat.drawerPending}</p>}
        {conv.schedule?.enabled && (
          <p className="schedule-note small">
            <ClockIcon size={14} />
            {t.schedule.teamNote(describeRepeat(conv.schedule.repeat, t, lang))}
          </p>
        )}
        {/* Before the lead agent has designed a team there are no members to change. */}
        {members && (
          <TeamReviser
            convId={conv.id}
            team={team}
            base={base}
            blocked={status === 'conflict'}
            leadText={leadText}
            onChange={setTeam}
            onBusy={setRevising}
          />
        )}
        {/* While the lead agent changes the team, it holds still. */}
        <fieldset className="team-fieldset" disabled={revising}>
          <TeamEditor
            value={team}
            onChange={setTeam}
            providers={providers}
            catalog={catalog}
            members={members}
            proposed={proposed}
            leadLabel={leadText}
            schedule={conv.schedule}
            convId={conv.id}
            onDrafting={setChecksDrafting}
            checksEditorVersion={checksEditorVersion}
          />
        </fieldset>
        <footer className="drawer-foot">
          {status === 'conflict' ? (
            <span className="error-line">
              {t.chat.drawerChanged}{' '}
              <button type="button" className="link-button" onClick={reload}>
                {t.chat.drawerReload}
              </button>
            </span>
          ) : (
            problems[0] && <span className="error-line">{problems[0]}</span>
          )}
          {running && (
            <span className="muted small">
              {reviewing ? t.chat.drawerReviewing : t.chat.drawerBusy}
              {!proposed && status !== 'conflict' && t.chat.drawerBusyReview}
            </span>
          )}
          <button className="ghost" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            className="primary"
            disabled={saving || revising || checksDrafting || status === 'conflict' || (!reviewOnly && (running || problems.length > 0))}
            onClick={save}
          >
            {t.common.save}
          </button>
        </footer>
      </aside>
    </div>
  );
}
