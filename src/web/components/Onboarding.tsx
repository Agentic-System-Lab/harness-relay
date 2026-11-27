import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { hashFor, scrollToSection, settingsHref, type SettingsSection } from '../route';
import { changed, isRead, markRead, readGuide, TOUR_STEPS, unread, type GuideState, type TopicId } from '../tour';
import { CheckIcon, ChevronIcon } from './icons';
import { TourArt } from './TourArt';

/** Where a topic's button goes: a page, or a card of Settings (scrolled to, as the app's links to it do). */
export const TOPIC_LINKS: Partial<Record<TopicId, { href: string; section?: SettingsSection }>> = {
  agents: { href: settingsHref('overview'), section: 'overview' },
  chat: { href: hashFor({ page: 'new' }) },
  phone: { href: settingsHref('home-screen'), section: 'home-screen' },
  automations: { href: hashFor({ page: 'schedule' }) },
  apps: { href: settingsHref('apps'), section: 'apps' },
  computer: { href: settingsHref('apps'), section: 'apps' },
  labs: { href: settingsHref('labs'), section: 'labs' },
};

/**
 * How far a key scrolls a topic's text that shows `page` pixels of its `total`: a line for the arrows,
 * nearly a page for Page Up and Down, all the way for Home and End; undefined for any other key.
 */
export function scrollBy(key: string, page: number, total: number): number | undefined {
  const line = 40;
  const full = Math.max(line, page - line);
  const by: Record<string, number> = { ArrowDown: line, ArrowUp: -line, PageDown: full, PageUp: -full, Home: -total, End: total };
  return by[key];
}

function stored(): GuideState | null {
  try {
    return readGuide();
  } catch {
    return null;
  }
}

/** The first topic not read yet, else the first. */
function firstTopic(): number {
  const [next] = unread(stored());
  return next ? TOUR_STEPS.findIndex((s) => s.id === next) : 0;
}

/**
 * The guided tour: a checklist of short topics beside the one shown, each checked once it has been
 * shown. Opened on a first visit, from the question the page asks about the topics left (TourNudge)
 * and from Settings. On a phone it is a sheet at the bottom showing the topic or, with All topics, the list.
 */
export function Onboarding({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [i, setI] = useState(firstTopic);
  const [state, setState] = useState(stored);
  /** On a phone, the sheet shows the topic or the list (a wide screen shows both). */
  const [view, setView] = useState<'topic' | 'list'>('topic');
  /** The topic's text is taller than the room it has: it scrolls, above the buttons. */
  const [scrolls, setScrolls] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const step = TOUR_STEPS[i]!;
  const text = t.tour.steps[i]!;
  const link = TOPIC_LINKS[step.id];
  const last = i === TOUR_STEPS.length - 1;
  const readCount = TOUR_STEPS.filter((s) => isRead(state, s.id)).length;

  // Shown: read.
  useEffect(() => {
    markRead(step.id);
    setState(stored());
  }, [step.id]);

  // Each topic starts at its top.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [i]);

  // Whether the topic's text scrolls (the line above the buttons) follows the window's size.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const update = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [i, t, view]);

  // Without scrolling: on a phone the sheet is still below the screen, sliding up, when Next takes the focus.
  useEffect(() => primary.current?.focus({ preventScroll: true }), []);

  const show = useCallback((n: number) => {
    setI(n);
    setView('topic');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setI((n) => Math.min(n + 1, TOUR_STEPS.length - 1));
      else if (e.key === 'ArrowLeft') setI((n) => Math.max(n - 1, 0));
      else {
        // The focus is on the buttons: the keys that scroll scroll the topic's text (it scrolls by
        // itself when it has the focus).
        const el = body.current;
        const by = el && e.target !== el ? scrollBy(e.key, el.clientHeight, el.scrollHeight) : undefined;
        if (el && by !== undefined) {
          e.preventDefault();
          el.scrollTop += by;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openList = () => {
    setView('list');
    // The topic shown, in the list that takes the sheet's place.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-current]')?.focus({ preventScroll: true }));
  };

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="tour-scrim" />
      <div className="tour-card" data-view={view}>
        <header className="tour-head">
          <h2 id="tour-title">{t.tour.title}</h2>
          <span className="tour-progress">{t.tour.progress(readCount, TOUR_STEPS.length)}</span>
          <button type="button" className="icon-button tour-close" onClick={onClose} aria-label={t.tour.close} title={t.tour.close}>
            ×
          </button>
        </header>
        <div className="tour-main">
          <nav className="tour-list" aria-label={t.tour.topics}>
            <ol ref={list}>
              {TOUR_STEPS.map((s, n) => {
                const read = isRead(state, s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={n === i ? 'on' : undefined}
                      aria-current={n === i ? 'step' : undefined}
                      onClick={() => {
                        show(n);
                        if (view === 'list') requestAnimationFrame(() => primary.current?.focus({ preventScroll: true }));
                      }}
                    >
                      <span className={`tour-mark ${read ? 'read' : ''}`} aria-hidden="true">
                        {read && <CheckIcon size={12} />}
                      </span>
                      <span className="tour-name">{t.tour.steps[n]!.title}</span>
                      {read ? (
                        <span className="visually-hidden">{t.tour.read}</span>
                      ) : (
                        changed(state, s.id) && <span className="tour-changed">{t.tour.changed}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <section className="tour-topic" aria-labelledby="tour-topic-title">
            <button type="button" className="tour-all" onClick={openList}>
              <ChevronIcon size={14} />
              {t.tour.allTopics}
            </button>
            <div
              ref={body}
              className="tour-body"
              // A stop for the keyboard only while the text scrolls.
              {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-labelledby': 'tour-topic-title' } : {})}
            >
              <TourArt key={step.id} topic={step.id} />
              <h3 id="tour-topic-title">{text.title}</h3>
              <p>{text.body}</p>
            </div>
            <div className={`tour-foot ${scrolls ? 'scrolls' : ''}`}>
              {link && text.action && (
                <a
                  className="ghost small-button tour-go"
                  href={link.href}
                  onClick={() => {
                    if (link.section) scrollToSection(link.section);
                    onClose();
                  }}
                >
                  {text.action}
                </a>
              )}
              <button ref={primary} type="button" className="primary small-button" onClick={() => (last ? onClose() : show(i + 1))}>
                {last ? t.tour.done : t.tour.next}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
