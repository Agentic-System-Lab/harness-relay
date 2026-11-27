import { describe, expect, it } from 'vitest';
import { readNotebook } from '../src/web/notebook';

describe('Jupyter notebook preview', () => {
  it('reads the cell order, language and sources of a compact notebook', () => {
    const file = {
      metadata: { language_info: { name: 'Julia' } },
      cells: [
        { cell_type: 'markdown', source: ['# Results\n', 'Details'] },
        { cell_type: 'raw', source: '<b>raw</b>' },
        { cell_type: 'code', source: [], execution_count: null, outputs: [] },
      ],
    };
    expect(readNotebook(JSON.stringify(file))).toEqual({
      language: 'julia',
      cells: [
        { kind: 'markdown', source: '# Results\nDetails' },
        { kind: 'raw', source: '<b>raw</b>' },
        { kind: 'code', source: '', count: null, outputs: [] },
      ],
    });
    expect(readNotebook('{"cells":[]}')?.cells).toEqual([]);
  });

  it('reads saved streams, errors and image or text representations without rendering active content', () => {
    const outputs = [
      { output_type: 'stream', name: 'stderr', text: ['log\n', 'end'] },
      { output_type: 'error', traceback: ['\x1b[31mError\x1b[0m', 'message'] },
      { output_type: 'error', ename: 'Exception', evalue: 'reason', traceback: [] },
      { output_type: 'display_data', data: { 'image/png': ['QU\n', 'JD'], 'text/plain': 'plot' } },
      { output_type: 'execute_result', data: { 'text/html': '<b>42</b>', 'text/plain': ['42'] } },
      { output_type: 'display_data', data: { 'image/svg+xml': '<svg/>', 'image/png': 'https://example.com/image' } },
    ];
    const cell = readNotebook(JSON.stringify({ cells: [{ cell_type: 'code', source: '', outputs, execution_count: 0 }] }))?.cells[0];
    expect(cell).toEqual({
      kind: 'code',
      source: '',
      count: 0,
      outputs: [
        { kind: 'error', text: 'log\nend' },
        { kind: 'error', text: 'Error\nmessage' },
        { kind: 'error', text: 'Exception: reason' },
        { kind: 'image', src: 'data:image/png;base64,QUJD', alt: 'plot' },
        { kind: 'text', text: '42' },
        { kind: 'unsupported' },
      ],
    });
  });

  it('falls back to source for incomplete JSON or an unrecognised notebook structure', () => {
    for (const file of ['{"cells":', 'null', '{}', '{"nbformat":3,"worksheets":[]}', '{"cells":[null]}', '{"cells":[{"source":[{}]}]}']) {
      expect(readNotebook(file)).toBeNull();
    }
  });
});
