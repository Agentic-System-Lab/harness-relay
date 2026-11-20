import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { ArrowDownIcon } from './icons';

/** Keep the submit button at the bottom of the card while its fields scroll. */
export function CreationPage({
  title,
  intro,
  children,
  onSubmit,
  submitLabel,
  disabled,
  problem,
  busy,
  error,
  automation,
}: {
  title: string;
  intro: ReactNode;
  children: ReactNode;
  onSubmit: () => void;
  submitLabel: string;
  disabled: boolean;
  problem?: string;
  busy: boolean;
  error?: string;
  automation?: boolean;
}) {
  const t = useT();
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLFieldSetElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const [more, setMore] = useState(false);

  useLayoutEffect(() => {
    const pane = scroll.current!;
    const measure = () => setMore(pane.scrollHeight - pane.clientHeight - pane.scrollTop > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(content.current!);
    pane.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      pane.removeEventListener('scroll', measure);
    };
  }, []);

  useLayoutEffect(() => {
    if (error) alert.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const scrollDown = () => {
    const pane = scroll.current!;
    pane.focus({ preventScroll: true });
    pane.scrollBy({
      top: pane.clientHeight * 0.8,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  };

  return (
    <div className="page new-chat-page">
      <div className="page-inner">
        <header className="page-head">
          <h1 id="creation-title">{title}</h1>
          <p className="muted">{intro}</p>
        </header>
        <section className={automation ? 'first-task automation-task' : 'first-task'}>
          <div
            className="scroll new-chat-body"
            id="creation-fields"
            role="region"
            aria-labelledby="creation-title"
            ref={scroll}
            tabIndex={-1}
          >
            <fieldset className="creation-fields" ref={content} disabled={busy}>
              {children}
              {(error || problem) && (
                <p role="alert" ref={alert} className="error-line">
                  {error || problem}
                </p>
              )}
            </fieldset>
          </div>
          <footer className="creation-footer start-bar first-task-actions">
            {more && (
              <button
                type="button"
                className="creation-scroll-hint"
                aria-controls="creation-fields"
                aria-label={t.newChat.scrollDown}
                title={t.newChat.scrollDown}
                onClick={scrollDown}
              >
                <ArrowDownIcon size={16} />
              </button>
            )}
            <button type="button" className="primary" disabled={busy || disabled} onClick={onSubmit}>
              {submitLabel}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
