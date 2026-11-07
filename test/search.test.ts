import { describe, expect, it } from 'vitest';
import { highlightParts, matchRanges, searchTerms, snippetAround, termsIn } from '../src/shared/search';

describe('search words', () => {
  it('splits a search into words without repeats', () => {
    expect(searchTerms('  React  sidebar react ')).toEqual(['React', 'sidebar']);
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('資料庫 遷移')).toEqual(['資料庫', '遷移']);
    expect(searchTerms('a b c d e f g h i j')).toHaveLength(8);
  });

  it('finds the words ignoring case, the longest match first, overlaps merged', () => {
    expect(matchRanges('React and react', ['REACT'])).toEqual([
      [0, 5],
      [10, 15],
    ]);
    expect(matchRanges('sidebar', ['side', 'sidebar'])).toEqual([[0, 7]]);
    expect(matchRanges('abcd', ['abc', 'bcd'])).toEqual([[0, 3]]);
    expect(matchRanges('a.b (c)', ['.', '(c)'])).toEqual([
      [1, 2],
      [4, 7],
    ]);
    expect(termsIn('Hello 世界', ['hello', '世界', 'x'])).toEqual(['hello', '世界']);
  });

  it('cuts an excerpt around the first match', () => {
    const long = `${'x '.repeat(100)}needle ${'y '.repeat(100)}`;
    const s = snippetAround(long, ['needle'], 40);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('needle');
    expect(s.length).toBeLessThanOrEqual(42);
    expect(snippetAround('short\n\ntext  here', ['text'])).toBe('short text here');
    expect(snippetAround('needle at the start', ['needle'], 10)).toBe('needle at…');
  });

  it('marks the matches to highlight', () => {
    expect(highlightParts('Use React hooks', ['react'])).toEqual([
      { text: 'Use ', match: false },
      { text: 'React', match: true },
      { text: ' hooks', match: false },
    ]);
    expect(highlightParts('nothing', ['x'])).toEqual([{ text: 'nothing', match: false }]);
    expect(highlightParts('', [])).toEqual([{ text: '', match: false }]);
  });
});
