import { Component, Suspense, type ReactNode } from 'react';
import { useT } from '../i18n';

/** What the page says when its own words could not be loaded either (`main.tsx`): both languages. */
export const PAGE_LOAD_FAILED = {
  text: 'Harness Relay 無法載入這個頁面。Harness Relay could not load this page.',
  reload: '重新載入 · Reload',
};

/** A note that a part of the page could not be loaded, with a button that reloads the page. */
export function LoadFailed({ text, reload, close, onClose }: { text: string; reload: string; close?: string; onClose?: () => void }) {
  return (
    <div className="load-failed" role="alert">
      <span>{text}</span>
      <span className="load-failed-buttons">
        {onClose && (
          <button type="button" className="ghost" onClick={onClose}>
            {close}
          </button>
        )}
        <button type="button" className="primary" onClick={() => location.reload()}>
          {reload}
        </button>
      </span>
    </div>
  );
}

function PartFailed({ onClose }: { onClose?: () => void }) {
  const t = useT();
  return <LoadFailed text={t.common.partFailed} reload={t.common.reload} close={t.common.close} onClose={onClose} />;
}

class Boundary extends Component<{ children: ReactNode; onClose?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(err: unknown): void {
    console.error(err);
  }

  render(): ReactNode {
    return this.state.failed ? <PartFailed onClose={this.props.onClose} /> : this.props.children;
  }
}

/**
 * A part of the page loaded when first shown (`React.lazy`): nothing while it loads; when it cannot be
 * loaded (or drawn), a note offering to reload the page instead of an empty page. The page reloads by
 * itself once first (`chunks.ts`). `onClose`: what closing the note does (the dialog it stands for).
 */
export function Deferred({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <Boundary onClose={onClose}>
      <Suspense fallback={null}>{children}</Suspense>
    </Boundary>
  );
}
