import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useDarkTheme } from '../theme';
import { CopyButton } from './CopyButton';

type MermaidApi = (typeof import('mermaid'))['default'];

// Mermaid is large, so it is loaded the first time a diagram is shown.
let loading: Promise<MermaidApi> | undefined;
const loadMermaid = () => (loading ??= import('mermaid').then((m) => m.default));

/** Wait this long after the source last changed: a streaming diagram is drawn once it stops growing. */
const SETTLE_MS = 300;

let seq = 0;

/**
 * The diagram as an <img> of its SVG. Agent output is untrusted, and an SVG shown as an image runs
 * no scripts and loads nothing from the network, whatever the diagram source says.
 */
async function draw(code: string, dark: boolean): Promise<{ src: string; width: number } | undefined> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || undefined,
  });
  if (!(await mermaid.parse(code, { suppressErrors: true }))) return undefined;
  const { svg } = await mermaid.render(`mermaid-${++seq}`, code);
  // Mermaid serialises as HTML; an SVG image must be well-formed XML. Give it its own size, too.
  const el = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  const box = el?.viewBox.baseVal;
  if (!el || !box?.width || !box.height) return undefined;
  el.setAttribute('width', String(Math.ceil(box.width)));
  el.setAttribute('height', String(Math.ceil(box.height)));
  el.style.removeProperty('max-width');
  const xml = new XMLSerializer().serializeToString(el);
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, width: Math.ceil(box.width) };
}

type Drawn = { code: string; src: string; width: number } | { code: string; failed: true };

/** A ```mermaid code block, drawn as a diagram (its source a click away). */
export function MermaidBlock({ code }: { code: string }) {
  const t = useT();
  // The page's theme: the system's, or the one chosen in Settings (theme.ts).
  const dark = useDarkTheme();
  const [drawn, setDrawn] = useState<Drawn>();
  const [source, setSource] = useState(false);
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      draw(code, dark)
        .then((d) => live && setDrawn(d ? { code, ...d } : { code, failed: true }))
        .catch(() => live && setDrawn({ code, failed: true }));
    }, SETTLE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [code, dark]);

  // Until the first drawing is ready (or when it cannot be drawn), the source is shown as before.
  const diagram = drawn && 'src' in drawn ? drawn : undefined;
  const failed = drawn && 'failed' in drawn && drawn.code === code;
  if (!diagram || failed) {
    return (
      <div className="mermaid-block">
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
        {failed && <p className="mermaid-note">{t.message.diagramFailed}</p>}
      </div>
    );
  }

  return (
    <div className="mermaid-block">
      <div className="mermaid-bar">
        <button type="button" className="mermaid-action" onClick={() => setSource((s) => !s)} aria-pressed={source}>
          {source ? t.message.diagram : t.message.diagramSource}
        </button>
        <CopyButton text={() => code} className="mermaid-action" />
      </div>
      {source ? (
        <pre>
          <code className="language-mermaid">{code}</code>
        </pre>
      ) : (
        <div className={`mermaid-view ${actualSize ? 'actual' : ''}`}>
          <button
            type="button"
            className="mermaid-zoom"
            title={actualSize ? t.message.diagramFit : t.message.diagramActual}
            aria-pressed={actualSize}
            onClick={() => setActualSize((a) => !a)}
          >
            <img src={diagram.src} width={diagram.width} alt={t.message.diagram} />
          </button>
        </div>
      )}
    </div>
  );
}
