import { COMMAND_NAME_RE, HANDOFF_LIMITS, INTERACTIVE_LIMITS, SECRET_NAME_RE, type CommandProposal } from './types';

/*
 * Steps only the user can take (docs/architecture.md, "Secrets and fixed commands"): blocks an agent
 * puts in its reply, on lines of their own, that Harness Relay takes out of its text and shows as cards.
 *
 *   <secret name="THREADS_ACCESS_TOKEN" label="Threads access token" url="https://…">why it is needed</secret>
 *   <command name="post" hosts="graph.threads.net" secrets="THREADS_ACCESS_TOKEN">python3 post.py</command>
 *   <command-run name="post">what the command reads on its standard input, once</command-run>
 *   <interactive reason="why">gcloud auth login --no-launch-browser</interactive>
 *
 * A `<secret>` asks the user for a value, which the server keeps for the working directory and gives
 * only to the fixed commands that name it; a `<command>` proposes such a command, which the user saves
 * (or not); a `<command-run>` puts one run of a saved command in the outbox, for the user to send; an
 * `<interactive>` asks the user to run a command themselves, from its card (a sign-in that waits for
 * them), `workdir="yes"` when it must run in the working directory.
 *
 * Only what is plainly a block is taken, as long-term memory's are (`src/shared/memory.ts`): it starts a
 * line (indented at most three spaces), nothing but other blocks follows it on its last line, it is not
 * code (in a fence, or indented as code) and does not run across a fence. A block whose name or values
 * are not valid stays as text, so the agent's words are never lost. Pure, shared by the server and the UI.
 */

export type HandoffBlock =
  | { kind: 'secret'; name: string; label?: string; reason?: string; url?: string }
  | ({ kind: 'command' } & CommandProposal)
  | { kind: 'command-run'; name: string; input: string }
  | { kind: 'interactive'; run: string; reason?: string; workdir?: boolean };

const TAGS = ['secret', 'command-run', 'command', 'interactive'] as const;
type Tag = (typeof TAGS)[number];

/** A fence's opening or closing line: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
/** A fence line anywhere in a text (one a block must not run across). */
const FENCE_LINE = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/;
/** A block's opening tag (the longer name first), its attributes in group 2. */
const OPEN = /<(secret|command-run|command|interactive)(?=[\s/>])([^>\n]*)>/iy;
/** Any of the tags, to skip texts that have none. */
const ANY = /<(?:secret|command-run|command|interactive)[\s/>]/i;

/** The most a block's body may hold, by tag: past it, the block is not one written for this. */
const MAX_BODY: Record<Tag, number> = {
  secret: HANDOFF_LIMITS.reason * 2,
  command: HANDOFF_LIMITS.commandLine,
  'command-run': HANDOFF_LIMITS.input,
  interactive: INTERACTIVE_LIMITS.commandLine * 2,
};

/** A host a command may reach: a name or an address, with a port or not. */
const HOST_RE = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/;

/** A value of the attributes of an opening tag, quoted or not. */
function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`/]+))`, 'i').exec(attrs);
  const value = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
  return value || undefined;
}

/** A list in an attribute: comma or space separated, each one trimmed, none empty, each once. */
function list(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(/[\s,]+/).filter(Boolean))];
}

/** A secret's name as given, in upper case; undefined when it is not one. */
export function secretName(value: string | undefined): string | undefined {
  const name = value?.trim().toUpperCase();
  return name && SECRET_NAME_RE.test(name) ? name : undefined;
}

/**
 * The page a `<secret>` block names, where the user gets the value (a token generator): an http or https
 * address without credentials in it, within `HANDOFF_LIMITS.secretUrl`; undefined when it is not one
 * (the block stays a block, without it).
 */
export function secretUrl(value: string | undefined): string | undefined {
  if (!value || value.length > HANDOFF_LIMITS.secretUrl) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** A fixed command's name as given, in lower case; undefined when it is not one. */
export function commandName(value: string | undefined): string | undefined {
  const name = value?.trim().toLowerCase();
  return name && COMMAND_NAME_RE.test(name) ? name : undefined;
}

/** A host as a command names it, in lower case; undefined when it is not one (a URL, a path, a bad port). */
export function hostName(value: string): string | undefined {
  const host = value.trim().toLowerCase();
  const m = HOST_RE.exec(host);
  if (!m) return undefined;
  if (m[1] !== undefined && (Number(m[1]) < 1 || Number(m[1]) > 65535)) return undefined;
  return host;
}

/**
 * A folder relative to the working directory, as a command's `cwd` names it: forward slashes, no `..`,
 * not absolute, not `.git`; '' for the top; undefined when it is not one.
 */
export function commandFolder(value: string | undefined): string | undefined {
  if (value === undefined) return '';
  const parts = value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.');
  if (/^(?:[a-z]:|\/)/i.test(value.trim())) return undefined;
  if (parts.some((p) => p === '..' || p.toLowerCase() === '.git' || /[\u0000-\u001f]/.test(p))) return undefined;
  return parts.join('/');
}

/**
 * Whether a command line holds what would make it read other than it runs: control characters (but
 * tab and line breaks), bidirectional overrides and isolates, zero-width characters, a byte order mark.
 */
export function hiddenCharacters(line: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(line);
}

/**
 * A command proposal checked: its name, a command line on its own (not empty, within the limit), at
 * most `HANDOFF_LIMITS.hosts` valid hosts and `commandSecrets` valid secret names. Undefined when any
 * part is not valid. Also checks what the user edits on the card, on the server.
 */
export function checkProposal(p: {
  name?: string;
  run?: string;
  hosts?: readonly string[];
  secrets?: readonly string[];
  cwd?: string;
}): CommandProposal | undefined {
  const name = commandName(p.name);
  const run = (p.run ?? '').trim();
  if (!name || !run || run.length > HANDOFF_LIMITS.commandLine || hiddenCharacters(run)) return undefined;
  const hosts = (p.hosts ?? []).map(hostName);
  const secrets = (p.secrets ?? []).map(secretName);
  if (hosts.some((h) => !h) || secrets.some((s) => !s)) return undefined;
  if (hosts.length > HANDOFF_LIMITS.hosts || secrets.length > HANDOFF_LIMITS.commandSecrets) return undefined;
  const cwd = commandFolder(p.cwd);
  // Not inside a folder of installed packages, whose code the pin passes over.
  if (cwd === undefined || UNPINNED_TOP.includes(cwd.split('/')[0]!)) return undefined;
  return {
    name,
    run,
    hosts: [...new Set(hosts as string[])],
    secrets: [...new Set(secrets as string[])],
    ...(cwd ? { cwd } : {}),
  };
}

/**
 * An interactive command's line as an agent wrote it, checked: trimmed (and out of one pair of
 * backticks around it all), not empty, within the limit, no NUL. Undefined when it is not one.
 */
export function interactiveLine(value: string | undefined): string | undefined {
  let run = (value ?? '').trim();
  const quoted = /^`([^`]+)`$/.exec(run);
  if (quoted) run = quoted[1]!.trim();
  if (!run || run.length > INTERACTIVE_LIMITS.commandLine || run.includes('\u0000')) return undefined;
  return run;
}

/** Where the current line ends (its `\n`, or the end of `text`). */
const lineEnd = (text: string, pos: number) => {
  const nl = text.indexOf('\n', pos);
  return nl < 0 ? text.length : nl;
};

/** The block whose opening tag is at `pos`, and where it ends; undefined when there is none, or it is not valid. */
function blockAt(text: string, pos: number): { block: HandoffBlock; end: number } | undefined {
  OPEN.lastIndex = pos;
  const open = OPEN.exec(text);
  if (!open) return undefined;
  const tag = open[1]!.toLowerCase() as Tag;
  let attrs = open[2] ?? '';
  const afterOpen = OPEN.lastIndex;
  const selfClosed = /\/\s*$/.test(attrs);
  if (selfClosed) attrs = attrs.replace(/\/\s*$/, '');
  let body = '';
  let end = afterOpen;
  if (!selfClosed) {
    const close = new RegExp(`</${tag}\\s*>`, 'gi');
    close.lastIndex = afterOpen;
    const m = close.exec(text);
    if (!m || m.index - afterOpen > MAX_BODY[tag]) return undefined;
    body = text.slice(afterOpen, m.index);
    // An unfinished block before another one, or one that runs across code: not a block.
    if (ANY.test(body) || FENCE_LINE.test(body)) return undefined;
    end = close.lastIndex;
  }
  if (tag === 'secret') {
    const name = secretName(attr(attrs, 'name'));
    if (!name) return undefined;
    const label = attr(attrs, 'label')?.slice(0, HANDOFF_LIMITS.label);
    const reason = body.trim().replace(/\s+/g, ' ').slice(0, HANDOFF_LIMITS.reason);
    const url = secretUrl(attr(attrs, 'url'));
    return { block: { kind: 'secret', name, ...(label ? { label } : {}), ...(reason ? { reason } : {}), ...(url ? { url } : {}) }, end };
  }
  if (tag === 'command') {
    const proposal = checkProposal({
      name: attr(attrs, 'name'),
      run: body,
      hosts: list(attr(attrs, 'hosts')),
      secrets: list(attr(attrs, 'secrets')),
      cwd: attr(attrs, 'cwd'),
    });
    return proposal ? { block: { kind: 'command', ...proposal }, end } : undefined;
  }
  if (tag === 'interactive') {
    const run = interactiveLine(body);
    if (!run) return undefined;
    const reason = attr(attrs, 'reason')?.replace(/\s+/g, ' ').slice(0, INTERACTIVE_LIMITS.reason);
    const workdir = /^(?:yes|true|1)$/i.test(attr(attrs, 'workdir') ?? '');
    return { block: { kind: 'interactive', run, ...(reason ? { reason } : {}), ...(workdir ? { workdir } : {}) }, end };
  }
  const name = commandName(attr(attrs, 'name'));
  if (!name) return undefined;
  // What the command reads: the block's lines, without the line breaks right after the tag and before its end.
  const input = body.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  return { block: { kind: 'command-run', name, input }, end };
}

/**
 * The blocks that start the line at `pos` (after at most three spaces) and end a line, one after
 * another, and where that line's break is; undefined when the line is not blocks alone.
 */
function blocksAt(text: string, pos: number): { blocks: HandoffBlock[]; end: number } | undefined {
  const indent = /^[ \t]*/.exec(text.slice(pos, pos + 8))![0];
  if (indent.replace(/\t/g, '    ').length > 3) return undefined;
  const blocks: HandoffBlock[] = [];
  let p = pos + indent.length;
  for (;;) {
    const found = blockAt(text, p);
    if (!found) return undefined;
    blocks.push(found.block);
    p = found.end;
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
    if (p >= text.length || text[p] === '\n') return { blocks, end: p };
  }
}

/** Where the fence opened by `mark` on the line ending at `end` closes: after its closing line, or the end of `text`. */
function fenceEnd(text: string, end: number, mark: string): number {
  let pos = end < text.length ? end + 1 : text.length;
  while (pos < text.length) {
    const e = lineEnd(text, pos);
    const line = text.slice(pos, e);
    const m = FENCE.exec(line);
    if (m && m[1]![0] === mark[0] && m[1]!.length >= mark.length && !line.trim().slice(m[1]!.length).trim()) {
      return e < text.length ? e + 1 : text.length;
    }
    pos = e < text.length ? e + 1 : text.length;
  }
  return text.length;
}

/** A line of indented code: four spaces (or a tab) in. */
const indentedCode = (line: string) => /^(?: {4}|\t)/.test(line);

/**
 * The hand-off blocks of a reply, in order, and its text without them. Only lines of blocks alone are
 * taken, outside code (see the top of this file).
 */
export function splitHandoffs(text: string): { text: string; blocks: HandoffBlock[] } {
  if (!ANY.test(text)) return { text, blocks: [] };
  const src = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
  const blocks: HandoffBlock[] = [];
  let out = '';
  let pos = 0;
  let inCode = false;
  let prevBlank = true;
  while (pos < src.length) {
    const end = lineEnd(src, pos);
    const next = end < src.length ? end + 1 : src.length;
    const line = src.slice(pos, end);
    const fence = FENCE.exec(line);
    if (fence) {
      const after = fenceEnd(src, end, fence[1]!);
      out += src.slice(pos, after);
      pos = after;
      inCode = false;
      prevBlank = false;
      continue;
    }
    const blank = !line.trim();
    if (!blank && indentedCode(line) && (prevBlank || inCode)) inCode = true;
    else if (!blank) inCode = false;
    const run = !inCode && !blank ? blocksAt(src, pos) : undefined;
    if (!run) {
      out += src.slice(pos, next);
      pos = next;
      prevBlank = blank;
      continue;
    }
    blocks.push(...run.blocks);
    pos = run.end < src.length ? run.end + 1 : src.length;
    // A block on lines of its own was taken out: the blank line after it goes too when one is before it.
    if (!out || out.endsWith('\n\n')) {
      const e = lineEnd(src, pos);
      if (e < src.length && !src.slice(pos, e).trim()) pos = e + 1;
    }
    prevBlank = true;
  }
  if (!blocks.length) return { text, blocks };
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

/**
 * A reply's text as it streams, without its hand-off blocks: those finished are taken out as when it
 * ends, and one still being written (an opening tag that starts a line, with no end yet) is hidden from
 * there on, so the chat never shows a block half written.
 */
export function withoutHandoffBlocks(text: string): string {
  if (!ANY.test(text)) return text;
  const done = splitHandoffs(text).text;
  const open = /(?:^|\n)[ \t]{0,3}<(?:secret|command-run|command|interactive)(?=[\s/>])/gi;
  let m: RegExpExecArray | null;
  let cut = -1;
  while ((m = open.exec(done))) {
    const from = m.index + (m[0].startsWith('\n') ? 1 : 0);
    const rest = done.slice(from);
    const tag = /<(secret|command-run|command|interactive)/i.exec(rest)![1]!.toLowerCase();
    if (!new RegExp(`</${tag}\\s*>|/>`, 'i').test(rest)) {
      cut = from;
      break;
    }
  }
  return cut < 0 ? done : done.slice(0, cut).trimEnd();
}

/**
 * What a secret's value may be: not empty once trimmed, at most `HANDOFF_LIMITS.secretValue` bytes, no
 * line break inside (a dotenv file holds one line each) and no NUL. Undefined when it is fine, else why.
 */
export function secretValueProblem(value: string): 'empty' | 'short' | 'long' | 'lines' | undefined {
  const v = value.trim();
  if (!v) return 'empty';
  // Shorter, it could not be masked in output without masking ordinary words (`maskValues`).
  if ([...v].length < 4) return 'short';
  if (new TextEncoder().encode(v).length > HANDOFF_LIMITS.secretValue) return 'long';
  if (/[\r\n\u0000]/.test(v)) return 'lines';
  return undefined;
}

/**
 * The folders of installed packages that a fixed command's pin passes over at the top of its folder, as
 * snapshots do; a command may not run from inside one, where its code would not be pinned.
 */
export const UNPINNED_TOP = ['node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'target'];

/**
 * `text` with the part of a value its start or end cut in two (output kept from its end, or cut at a
 * limit) replaced by dots too: a value's last characters at the very start, its first at the very end,
 * four at least.
 */
export function maskEdges(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) {
    if (v.length < 5) continue;
    for (let k = v.length - 1; k >= 4; k--) {
      const head = v.slice(v.length - k);
      const at = out.startsWith('…\n') ? 2 : 0;
      if (out.startsWith(head, at)) {
        out = `${out.slice(0, at)}••••${out.slice(at + k)}`;
        break;
      }
    }
    for (let k = v.length - 1; k >= 4; k--) {
      if (out.endsWith(v.slice(0, k))) {
        out = `${out.slice(0, out.length - k)}••••`;
        break;
      }
    }
  }
  return out;
}

/**
 * `text` with every one of `values` replaced by dots: the longest first, so one that holds another is
 * masked whole. Values shorter than four characters are left (they would mask ordinary words).
 */
export function maskValues(text: string, values: readonly string[]): string {
  const kept = [...new Set(values.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of kept) out = out.split(v).join('••••');
  return out;
}
