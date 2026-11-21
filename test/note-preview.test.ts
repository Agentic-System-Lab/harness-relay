import { expect, it } from 'vitest';
import { changeBlocks, noteFormat } from '../src/web/notePreview';

it.each([
  ['', '', '', '', '', ''],
  ['', 'added\r\n', '', '', 'added\r\n', ''],
  ['same\nsame\n', 'same\n', 'same\n', 'same\n', '', ''],
  ['first\rold\rlast', 'first\rnew\rlast', 'first\r', 'old\r', 'new\r', 'last'],
  ['\uFEFFfirst\r\n\nlast\r', '\uFEFFfirst\r\n\r\nlast\r', '\uFEFFfirst\r\n', '\n', '\r\n', 'last\r'],
  ['last\n', 'last', '', 'last\n', 'last', ''],
  ['same\r\n', 'same\r\n', 'same\r\n', '', '', ''],
])('preserves the exact versions when comparing %j and %j', (before, after, context, removed, added, end) => {
  expect(changeBlocks(before, after)).toEqual({ context, removed, added, end });
  expect(context + removed + end).toBe(before);
  expect(context + added + end).toBe(after);
});

it.each([
  ['', false, '', false],
  ['\uFEFF', true, '', false],
  ['a\r\nb', false, 'CRLF', false],
  ['\uFEFFa\r', true, 'CR', true],
  ['\n', false, 'LF', true],
  ['a\r\nb\nc\r', false, 'mixed', true],
])('describes BOM, line endings, and the final newline of %j', (value, bom, lineEnding, finalNewline) => {
  expect(noteFormat(value)).toEqual({ bom, lineEnding, finalNewline });
});
