import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

/*
 * One @mention rule for the server (who is addressed) and the UI (which mentions are highlighted).
 * Both read the message as Markdown with the same parser (GFM) and look only at prose: text outside
 * code (inline, fenced, indented) and outside links (including autolinked URLs and e-mail addresses).
 */

const ASCII_WORD = /[A-Za-z0-9_-]/;

/**
 * Where one piece of prose @mentions one of `names`: a name right after `@` (at the start, or after a
 * character other than a letter, digit, `_`, `@` or `.`), case-insensitive, longest name first. Text
 * may follow the name directly (`@Builder請實作`); only an ASCII letter, digit, `_` or `-` right after a
 * name ending in one means a longer word (`@Bobby` is not `@Bob`).
 */
export function findMentions(text: string, names: string[]): { start: number; end: number; name: string }[] {
  const longestFirst = names.filter(Boolean).sort((a, b) => b.length - a.length);
  const out: { start: number; end: number; name: string }[] = [];
  if (!longestFirst.length) return out;
  for (const m of text.matchAll(/(^|[^\w@.])@/g)) {
    const start = m.index + m[0].length - 1;
    const rest = text.slice(start + 1);
    const name = longestFirst.find((n) => {
      if (rest.slice(0, n.length).toLowerCase() !== n.toLowerCase()) return false;
      const next = rest[n.length];
      return !(next && ASCII_WORD.test(next) && ASCII_WORD.test(n[n.length - 1]!));
    });
    if (name) out.push({ start, end: start + 1 + name.length, name });
  }
  return out;
}

/** The few fields of a Markdown syntax tree (mdast) node used here. */
export interface MentionNode {
  type: string;
  value?: string;
  children?: MentionNode[];
}

/** Node types whose text is not prose for mentions (code nodes have no text children, so they need no entry). */
export const NOT_PROSE = new Set(['link', 'linkReference', 'image', 'imageReference']);

/** Each prose text node of a Markdown tree, in document order. */
export function proseTexts(node: MentionNode, out: MentionNode[] = []): MentionNode[] {
  for (const child of node.children ?? []) {
    if (NOT_PROSE.has(child.type)) continue;
    if (child.type === 'text') out.push(child);
    else proseTexts(child, out);
  }
  return out;
}

/** Names from `names` @mentioned in Markdown `text`, in order of first mention (as given in `names`). */
export function mentionsInMarkdown(text: string, names: string[]): string[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MentionNode;
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const out: string[] = [];
  for (const node of proseTexts(tree)) {
    for (const m of findMentions(node.value ?? '', names)) {
      const name = byLower.get(m.name.toLowerCase())!;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Names @mentioned in Markdown `text` that are none of `names` (case-insensitive), in order, each once:
 * mentions that reach nobody. Prose only, as for `mentionsInMarkdown`. A name made of ASCII letters,
 * digits, `_` and `-` ends where they end; any other ends at a space or punctuation, so Chinese text
 * written right after one is taken as part of it (`@小明請看`). One followed by `/` or `(` is code,
 * not a name: a package scope (`@types/node`) or a decorator (`@Component(…)`).
 */
export function unknownMentions(text: string, names: string[]): string[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MentionNode;
  const known = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  for (const node of proseTexts(tree)) {
    const value = node.value ?? '';
    const taken = new Set(findMentions(value, names).map((m) => m.start));
    for (const m of value.matchAll(/(^|[^\w@.])@/g)) {
      const start = m.index + m[0].length - 1;
      if (taken.has(start)) continue;
      const rest = value.slice(start + 1);
      const name = (/^[A-Za-z0-9_-]{1,32}/.exec(rest) ?? /^[\p{L}\p{N}_-]{1,32}/u.exec(rest))?.[0];
      if (!name || rest[name.length] === '/' || rest[name.length] === '(') continue;
      if (!known.has(name.toLowerCase()) && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
    }
  }
  return out;
}
