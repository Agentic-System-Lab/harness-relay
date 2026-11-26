// The guided tour: a checklist of short topics (components/Onboarding.tsx), each checked once read.
// Before the checklist, a browser kept only the last tour version it finished or skipped, in DONE_KEY
// (pre-versioned tours stored '1'): every topic up to that version counts as read.
const DONE_KEY = 'relay:onboarded';
/** The topics read, each at the revision it was read in, and the version a "Not now" answered. */
const GUIDE_KEY = 'relay:guide';
export const TOUR_VERSION = 47;

/** Ordered like tour.steps in both locales. Topics added after the checklist also record when they first appeared. */
export const TOUR_STEPS = [
  { id: 'welcome', revision: 17 },
  { id: 'agents', revision: 39 }, // signing in, the open agents' model connections
  { id: 'chat', revision: 46 }, // the team the lead agent builds, the file permission
  { id: 'team', revision: 45 }, // replies as they come, approvals, questions, cards for the user
  { id: 'replies', revision: 47, introduced: 47 }, // follow up with the author and see each stage's reported usage
  { id: 'phone', revision: 23 },
  { id: 'automations', revision: 44 },
  { id: 'apps', revision: 33 },
] as const satisfies readonly { id: string; revision: number; introduced?: number }[];

export type TopicId = (typeof TOUR_STEPS)[number]['id'];

/** What this browser keeps of the tour. */
export interface GuideState {
  /** Every topic with a revision up to it was read (the tour version a browser finished before the checklist). */
  base: number;
  /** The revision each topic was last read in. */
  seen: Partial<Record<TopicId, number>>;
  /** No asking again until a topic changes after this version ("Not now"). */
  quiet: number;
}

function storedVersion(stored: string | null): number {
  const version = Number(stored);
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

function revisionOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The state as stored: null for a browser that never opened the tour. */
export function parseGuide(done: string | null, guide: string | null): GuideState | null {
  if (done === null && guide === null) return null;
  let parsed: { seen?: unknown; quiet?: unknown } = {};
  try {
    const value: unknown = guide === null ? {} : JSON.parse(guide);
    if (value && typeof value === 'object') parsed = value;
  } catch {
    /* a broken value counts as nothing read */
  }
  const seen: GuideState['seen'] = {};
  const stored = parsed.seen && typeof parsed.seen === 'object' ? (parsed.seen as Record<string, unknown>) : {};
  for (const { id } of TOUR_STEPS) {
    const revision = revisionOf(stored[id]);
    if (revision) seen[id] = revision;
  }
  return { base: storedVersion(done), seen, quiet: revisionOf(parsed.quiet) };
}

export function isRead(state: GuideState | null, id: TopicId): boolean {
  const topic = TOUR_STEPS.find((s) => s.id === id)!;
  return Boolean(state) && topic.revision <= Math.max(state!.base, state!.seen[id] ?? 0);
}

/** The topics not read in their current revision, in tour order. */
export function unread(state: GuideState | null): TopicId[] {
  return TOUR_STEPS.filter((s) => !isRead(state, s.id)).map((s) => s.id);
}

/** Whether a topic not read now was read in an earlier revision: it changed since. */
export function changed(state: GuideState | null, id: TopicId): boolean {
  if (!state || isRead(state, id)) return false;
  const topic = TOUR_STEPS.find((s) => s.id === id)!;
  return state.seen[id] !== undefined || state.base >= ('introduced' in topic ? topic.introduced : 1);
}

/**
 * What the page does with the tour as it opens: `open` it on a first visit, `ask` about the topics
 * left to read (unless "Not now" answered for them), or nothing.
 */
export function guideOnStart(state: GuideState | null): 'open' | 'ask' | null {
  if (!state) return 'open';
  const left = TOUR_STEPS.filter((s) => !isRead(state, s.id));
  return left.some((s) => s.revision > state.quiet) ? 'ask' : null;
}

export function readGuide(): GuideState | null {
  return parseGuide(localStorage.getItem(DONE_KEY), localStorage.getItem(GUIDE_KEY));
}

function writeGuide(change: (state: GuideState) => GuideState): void {
  try {
    const state = change(readGuide() ?? { base: 0, seen: {}, quiet: 0 });
    localStorage.setItem(GUIDE_KEY, JSON.stringify({ seen: state.seen, quiet: state.quiet }));
  } catch {
    /* storage unavailable */
  }
}

/** What the page does with the tour as it opens; nothing without storage (Settings still opens it). */
export function pendingTour(): 'open' | 'ask' | null {
  try {
    return guideOnStart(readGuide());
  } catch {
    return null;
  }
}

/** A topic was shown: checked, in its current revision. */
export function markRead(id: TopicId): void {
  const revision = TOUR_STEPS.find((s) => s.id === id)!.revision;
  writeGuide((state) => (isRead(state, id) ? state : { ...state, seen: { ...state.seen, [id]: revision } }));
}

/** "Not now": no asking again until a topic changes. */
export function quietTour(): void {
  writeGuide((state) => ({ ...state, quiet: Math.max(state.quiet, TOUR_VERSION) }));
}
