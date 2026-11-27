import { useT } from '../i18n';
import type { Notebook } from '../notebook';
import { CodeView } from './CodeView';
import { Markdown } from './Markdown';

export function NotebookPreview({ notebook }: { notebook: Notebook }) {
  const t = useT();
  if (!notebook.cells.length) return <p className="muted preview-empty">{t.files.emptyNotebook}</p>;
  return (
    <div className="notebook-preview">
      {notebook.cells.map((cell, index) => (
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
            <Markdown text={cell.source} />
          ) : (
            <pre className="notebook-raw">{cell.source}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
