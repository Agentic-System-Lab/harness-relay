import { Component, Suspense, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { PartLoadError, loadPart } from '../chunks';
import { useT } from '../i18n';

/** What the page says when its own words could not be loaded either (`main.tsx`): both languages. */
export const PAGE_LOAD_FAILED = {
  text: 'Harness Relay 無法載入這個頁面。Harness Relay could not load this page.',
  reload: '重新載入 · Reload',
};

/**
 * A note that a part of the page could not be loaded or shown, with a button that reloads the page:
 * at the bottom of the screen, over everything (a dialog it stands for), or `inPage` in the page's own
 * place (Settings), leaving the rest of the screen alone.
 */
export function LoadFailed({ text, reload, close, onClose, inPage }: { text: string; reload: string; close?: string; onClose?: () => void; inPage?: boolean }) {
  return (
    <div className={inPage ? 'load-failed in-page' : 'load-failed'} role="alert">
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

type Failed = 'load' | 'draw' | null;

function PartFailed({ failed, onClose, inPage }: { failed: Exclude<Failed, null>; onClose?: () => void; inPage?: boolean }) {
  const t = useT();
  const text = failed === 'load' ? t.common.partFailed : t.common.partBroken;
  return <LoadFailed text={text} reload={t.common.reload} close={t.common.close} onClose={onClose} inPage={inPage} />;
}

interface BoundaryProps {
  children: ReactNode;
  onClose?: () => void;
  inPage?: boolean;
}

class Boundary extends Component<BoundaryProps, { failed: Failed }> {
  state: { failed: Failed } = { failed: null };

  static getDerivedStateFromError(err: unknown): { failed: Failed } {
    return { failed: err instanceof PartLoadError ? 'load' : 'draw' };
  }

  componentDidCatch(err: unknown): void {
    console.error(err);
  }

  render(): ReactNode {
    const { failed } = this.state;
    return failed ? <PartFailed failed={failed} onClose={this.props.onClose} inPage={this.props.inPage} /> : this.props.children;
  }
}

/**
 * A component loaded when first shown, through `loadPart`: the page reloads once for it when it
 * cannot be loaded, and it fails with a `PartLoadError` when it still cannot. Show it in `Deferred`.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => loadPart(load).then((component) => ({ default: component })));
}

/**
 * A part of the page loaded when first shown (`lazyPart`): nothing while it loads; when it cannot be
 * loaded, or fails to draw, a note saying which, with a button to reload the page, instead of an
 * empty page. `onClose`: what closing the note does (the dialog it stands for); `inPage`: the note in
 * the part's place, for a page (Settings).
 */
export function Deferred({ children, onClose, inPage }: BoundaryProps) {
  return (
    <Boundary onClose={onClose} inPage={inPage}>
      <Suspense fallback={null}>{children}</Suspense>
    </Boundary>
  );
}
