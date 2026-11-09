// The file browser's pure logic (paths are relative to the browsed folder and use `/`).

import type { FileEntry, ZipCheck } from '../shared/types';

/** The breadcrumb for a folder: the root ('') first, then each folder down to `path`. */
export function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  return [{ name: '', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
}

export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Entries whose name contains `query` (case-insensitive), in the same order. */
export function filterEntries(entries: FileEntry[], query: string): FileEntry[] {
  const q = query.trim().toLowerCase();
  return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

const NAMED: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.gitignore': 'bash',
  '.env': 'bash',
};

const BY_EXT: Record<string, string> = {
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'javascript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  htm: 'xml',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  zsh: 'bash',
  sh: 'bash',
  yml: 'yaml',
  toml: 'ini',
  jsonc: 'json',
  lock: 'json',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  kt: 'kotlin',
  rs: 'rust',
  py: 'python',
  rb: 'ruby',
  ps1: 'powershell',
};

/** The highlight.js language to try for a file name (its extension when no better guess), or undefined. */
export function codeLanguage(name: string): string | undefined {
  const base = name.split('/').pop()!.toLowerCase();
  if (NAMED[base]) return NAMED[base];
  const ext = /\.([a-z0-9]+)$/.exec(base)?.[1];
  if (!ext) return undefined;
  return BY_EXT[ext] ?? ext;
}

/** The number of lines in a text, counting a last line without a line break. */
export function lineCount(text: string): number {
  if (!text) return 0;
  const breaks = text.match(/\n/g)?.length ?? 0;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/**
 * What downloading a folder as a ZIP file does, given what it would hold: all of it; or, when that is
 * too much but what git does not ignore is not (and is something), offer that; or it is too large.
 */
export function zipChoice(check: ZipCheck): 'all' | 'unignored' | 'tooBig' {
  if (check.all) return 'all';
  return check.unignored && check.unignored.files > 0 ? 'unignored' : 'tooBig';
}
