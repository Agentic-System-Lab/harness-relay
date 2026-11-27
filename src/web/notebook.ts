// The parts of an ipynb file the Files panel can display without starting a kernel.
type Output = { kind: 'text' | 'error'; text: string } | { kind: 'image'; src: string; alt?: string } | { kind: 'unsupported' };

type Cell = { kind: 'markdown' | 'raw'; source: string } | { kind: 'code'; source: string; count: number | null; outputs: Output[] };

export interface Notebook {
  language?: string;
  cells: Cell[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Notebook sources and output text on disk may be split into strings which keep their line breaks. */
function multiline(value: unknown, separator = ''): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(separator);
  return undefined;
}

function output(value: unknown): Output {
  if (object(value)) {
    let text: string | undefined;
    let error = false;
    if (value.output_type === 'stream') {
      text = multiline(value.text);
      error = value.name === 'stderr';
    } else if (value.output_type === 'error') {
      error = true;
      text = multiline(value.traceback, '\n') || [value.ename, value.evalue].filter((s) => typeof s === 'string').join(': ');
    } else if ((value.output_type === 'display_data' || value.output_type === 'execute_result') && object(value.data)) {
      text = multiline(value.data['text/plain']);
      for (const mime of ['image/png', 'image/jpeg']) {
        const data = multiline(value.data[mime])?.replace(/\s/g, '');
        if (data && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { kind: 'image', src: `data:${mime};base64,${data}`, alt: text };
      }
    }
    if (text !== undefined) return { kind: error ? 'error' : 'text', text: text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') };
  }
  return { kind: 'unsupported' };
}

/** Return null for an unreadable notebook so the original file is still available as text. */
export function readNotebook(text: string): Notebook | null {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  if (!object(file) || !Array.isArray(file.cells) || (file.nbformat !== undefined && file.nbformat !== 4)) return null;
  const cells: Cell[] = [];
  for (const cell of file.cells) {
    if (!object(cell)) return null;
    const source = multiline(cell.source);
    if (source === undefined) return null;
    if (cell.cell_type === 'code') {
      if (cell.outputs !== undefined && !Array.isArray(cell.outputs)) return null;
      cells.push({
        kind: 'code',
        source,
        count: typeof cell.execution_count === 'number' && Number.isInteger(cell.execution_count) ? cell.execution_count : null,
        outputs: (cell.outputs ?? []).map(output),
      });
    } else if (cell.cell_type === 'markdown' || cell.cell_type === 'raw') {
      cells.push({ kind: cell.cell_type, source });
    } else {
      return null;
    }
  }
  const meta = object(file.metadata) ? file.metadata : {};
  const language = (object(meta.language_info) && meta.language_info.name) || (object(meta.kernelspec) && meta.kernelspec.language);
  return { cells, language: typeof language === 'string' ? language.toLowerCase() : undefined };
}
