// This browser's last finished or skipped tour. Pre-versioned tours stored '1' in the same key.
const DONE_KEY = 'relay:onboarded';
export const TOUR_VERSION = 45;

/** Ordered like tour.steps in both locales. Each revision is when that step last changed for readers. */
export const TOUR_STEPS: { target?: string; revision: number }[] = [
  { revision: 17 }, // welcome
  { target: 'settings', revision: 20 }, // check agents
  { target: 'pair-phone', revision: 23 }, // connect a phone
  { target: 'settings', revision: 39 }, // model connections (context windows)
  { target: 'new-chat', revision: 44 }, // new chat (the lead agent writes a template)
  { revision: 39 }, // auto team (a member's own limit)
  { revision: 1 }, // modes
  { revision: 9 }, // writing a message
  { revision: 39 }, // while the team replies (subagents, steering)
  { revision: 45 }, // when the team needs you (steps, secrets and fixed commands, signing in, the browser handed over)
  { target: 'settings', revision: 23 }, // notifications and sound
  { target: 'inbox', revision: 18 },
  { revision: 42 }, // permissions (Approve for me)
  { revision: 44 }, // team checks (the lead agent writes them)
  { revision: 45 }, // files (editing and uploading; app previews: Dockerfiles, opening by themselves, the header's button; publishing)
  { revision: 20 }, // share
  { target: 'new-schedule', revision: 44 }, // automations (filled in from a sentence, proposed in a chat)
  { target: 'organize', revision: 44 }, // groups (the lead agent suggests them, names new chats)
  { target: 'settings', revision: 33 }, // common apps and the tool library
  { target: 'settings', revision: 43 }, // long-term memory (in Labs, off by default)
  { target: 'settings', revision: 4 }, // agent sessions
  { target: 'settings', revision: 43 }, // settings (Labs: long-term memory too; subagents and workflows)
];

export function tourIndices(since: number): number[] {
  return TOUR_STEPS.flatMap((step, index) => (step.revision > since ? [index] : []));
}

function storedVersion(stored: string | null): number {
  const version = Number(stored);
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

/** Zero opens the full tour, a positive version opens the changes since then, null means up to date. */
export function pendingTour(): number | null {
  try {
    const seen = storedVersion(localStorage.getItem(DONE_KEY));
    return seen >= TOUR_VERSION ? null : seen;
  } catch {
    return null; // No storage: the full tour stays available from Settings.
  }
}

export function markDone(): void {
  try {
    if (storedVersion(localStorage.getItem(DONE_KEY)) < TOUR_VERSION) localStorage.setItem(DONE_KEY, String(TOUR_VERSION));
  } catch {
    /* storage unavailable */
  }
}
