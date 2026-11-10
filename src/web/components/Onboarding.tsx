import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

/** The version of the tour this browser last finished (or skipped); before versions, `'1'`. */
const DONE_KEY = 'relay:onboarded';

/**
 * Raise it when the steps change in a way worth seeing: people who finished an earlier version see the tour again
 * once, on their next visit. `test/tour.test.ts` fails when the steps change, as a reminder.
 */
export const TOUR_VERSION = 10;

/**
 * Element each step points at (`data-tour`), by the index of the step in `t.tour.steps`; none = a centred card.
 * Keep it as long as the steps (`test/tour.test.ts` checks).
 */
export const TOUR_TARGETS: (string | undefined)[] = [
  undefined, // welcome
  'settings', // sign in
  'new-chat', // new chat
  undefined, // auto team
  undefined, // modes
  undefined, // writing a message
  undefined, // while the team replies
  undefined, // when the team needs you
  undefined, // file permission
  undefined, // browsing files (the button is in a chat's header)
  undefined, // sharing a conversation (in a chat's header, and under each reply)
  'new-schedule', // schedules (New schedule, beside New chat)
  'organize', // groups and search
  'settings', // tool library
  'settings', // agent sessions and AgentsView
  'settings', // settings
];

/** Whether the stored version (`DONE_KEY`) means the current tour was seen; a newer one counts too. */
export function tourSeen(stored: string | null, version = TOUR_VERSION): boolean {
  return Number(stored) >= version;
}

export function onboardingDone(): boolean {
  try {
    return tourSeen(localStorage.getItem(DONE_KEY));
  } catch {
    return true; // no storage: don't show the tour on every visit
  }
}

function markDone(): void {
  try {
    localStorage.setItem(DONE_KEY, String(TOUR_VERSION));
  } catch {
    /* storage unavailable */
  }
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The target's box when it is actually on screen (the sidebar is off-canvas on small screens). */
function targetBox(name: string | undefined): Box | null {
  if (!name) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  const r = el?.getBoundingClientRect();
  if (!r || r.width === 0 || r.right <= 0 || r.left >= window.innerWidth) return null;
  const pad = 6;
  return { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

const CARD_WIDTH = 360;

/** Next to the target when there is room on its right, otherwise below or above it. */
function cardPosition(box: Box, cardHeight: number): { top: number; left: number } {
  const margin = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampTop = (top: number) => Math.max(margin, Math.min(top, vh - cardHeight - margin));
  if (box.left + box.width + margin + CARD_WIDTH <= vw - margin) {
    return { top: clampTop(box.top), left: box.left + box.width + margin };
  }
  const left = Math.max(margin, Math.min(box.left, vw - CARD_WIDTH - margin));
  const below = box.top + box.height + margin;
  return below + cardHeight <= vh - margin ? { top: below, left } : { top: clampTop(box.top - cardHeight - margin), left };
}

/** A step-by-step guide to the main features, shown on the first visit and from Settings. */
export function Onboarding({ onClose }: { onClose: () => void }) {
  const t = useT();
  const steps = t.tour.steps;
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [cardHeight, setCardHeight] = useState(240);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const step = steps[i]!;
  const last = i === steps.length - 1;

  const finish = useCallback(() => {
    markDone();
    onClose();
  }, [onClose]);

  // Track the target (layout can change: resizing, the sidebar opening).
  useLayoutEffect(() => {
    const update = () => setBox(targetBox(TOUR_TARGETS[i]));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [i]);

  useLayoutEffect(() => {
    if (card.current) setCardHeight(card.current.offsetHeight);
  }, [i, box, t]);

  useEffect(() => primary.current?.focus(), [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') setI((n) => Math.min(n + 1, steps.length - 1));
      else if (e.key === 'ArrowLeft') setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish, steps.length]);

  const pos = box ? cardPosition(box, cardHeight) : null;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className={`tour-scrim ${box ? '' : 'dim'}`} />
      {box && <div className="tour-spot" style={box} aria-hidden />}
      <div
        ref={card}
        className={`tour-card ${pos ? 'anchored' : 'centered'}`}
        style={pos ? { top: pos.top, left: pos.left, width: CARD_WIDTH } : undefined}
      >
        <div className="tour-top">
          <span className="tour-label">{t.tour.label}</span>
          <span className="tour-count">{t.tour.step(i + 1, steps.length)}</span>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>
        {step.points && (
          <ul>
            {step.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="tour-dots" aria-hidden>
          {steps.map((_, n) => (
            <i key={n} className={n === i ? 'on' : ''} />
          ))}
        </div>
        <div className="tour-actions">
          {!last && (
            <button type="button" className="link-button tour-skip" onClick={finish}>
              {t.tour.skip}
            </button>
          )}
          {i > 0 && (
            <button type="button" className="ghost small-button" onClick={() => setI(i - 1)}>
              {t.tour.back}
            </button>
          )}
          <button
            ref={primary}
            type="button"
            className="primary small-button"
            onClick={() => (last ? finish() : setI(i + 1))}
          >
            {last ? t.tour.done : t.tour.next}
          </button>
        </div>
      </div>
    </div>
  );
}
