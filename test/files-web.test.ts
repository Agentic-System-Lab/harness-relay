import { describe, expect, it } from 'vitest';
import { codeLanguage, crumbs, filterEntries, isMarkdown, joinPath, lineCount, parentPath } from '../src/web/files';
import type { FileEntry } from '../src/shared/types';

describe('file browser paths', () => {
  it('builds the breadcrumb from the root down', () => {
    expect(crumbs('')).toEqual([{ name: '', path: '' }]);
    expect(crumbs('src/web/')).toEqual([
      { name: '', path: '' },
      { name: 'src', path: 'src' },
      { name: 'web', path: 'src/web' },
    ]);
  });

  it('goes up and down a level', () => {
    expect(parentPath('src/web')).toBe('src');
    expect(parentPath('src')).toBe('');
    expect(parentPath('')).toBe('');
    expect(joinPath('', 'a.ts')).toBe('a.ts');
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts');
  });
});

describe('file browser listing and preview', () => {
  const entries: FileEntry[] = [
    { name: 'Docs', kind: 'dir', size: 0, mtime: 0 },
    { name: 'readme.md', kind: 'file', size: 1, mtime: 0 },
    { name: 'app.ts', kind: 'file', size: 1, mtime: 0 },
  ];

  it('filters by name, ignoring case', () => {
    expect(filterEntries(entries, ' d').map((e) => e.name)).toEqual(['Docs', 'readme.md']);
    expect(filterEntries(entries, '')).toBe(entries);
  });

  it('recognises Markdown and guesses the code language', () => {
    expect(isMarkdown('docs/README.md')).toBe(true);
    expect(isMarkdown('notes.markdown')).toBe(true);
    expect(isMarkdown('md.ts')).toBe(false);
    expect(codeLanguage('src/App.tsx')).toBe('typescript');
    expect(codeLanguage('main.py')).toBe('python');
    expect(codeLanguage('Dockerfile')).toBe('dockerfile');
    expect(codeLanguage('styles.css')).toBe('css');
    expect(codeLanguage('LICENSE')).toBeUndefined();
  });

  it('counts lines with or without a final line break', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\n')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
  });
});
