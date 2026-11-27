import { useState } from 'react';
import { useT } from '../i18n';
import type { Notebook } from '../notebook';
import { CodeView } from './CodeView';
import { Markdown } from './Markdown';

// Parsing Markdown and highlighting code are synchronous, even for cells outside the viewport.
const CELLS_PER_BATCH = 40;

export function NotebookPreview({ notebook }: { notebook: Notebook }) {
  const t = useT();
  const [visible, setVisible] = useState(CELLS_PER_BATCH);
  if (!notebook.cells.length) return <p className="muted preview-empty">{t.files.emptyNotebook}</p>;
  return (
    <div className="notebook-preview">
      {notebook.cells.slice(0, visible).map((cell, index) => (
        <div className="notebook-cell" key={index}>
          {cell.kind === 'code' ? (
            <>
              <span className="notebook-prompt">[{cell.count ?? ' '}]:</span>
              <CodeView text={cell.source} language={notebook.language} />
              {cell.outputs.map((out, i) => (
                <div className="notebook-output" key={i}>
                  {out.kind === 'image' ? (
                    <img src={out.src} alt={out.alt || t.files.notebookImage} loading="lazy" />
                  ) : out.kind === 'unsupported' ? (
                    <span className="muted small">{t.files.unsupportedOutput}</span>
                  ) : (
                    <pre className={out.kind === 'error' ? 'error-line' : undefined}>{out.text}</pre>
                  )}
                </div>
              ))}
            </>
          ) : cell.kind === 'markdown' ? (
            <Markdown text={cell.source} attachments={cell.attachments} />
          ) : (
            <pre className="notebook-raw">{cell.source}</pre>
          )}
        </div>
      ))}
      {visible < notebook.cells.length && (
        <button className="ghost small-button notebook-more" onClick={() => setVisible((count) => count + CELLS_PER_BATCH)}>
          {t.files.moreCells(Math.min(CELLS_PER_BATCH, notebook.cells.length - visible))}
        </button>
      )}
    </div>
  );
}
