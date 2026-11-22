import { findMentions, mentionsInMarkdown } from './mentions';
import { STEPS_LIMITS, type ChatMessage, type MessagePart, type StepItem } from './types';

/*
 * Steps only the user can take outside Harness Relay ("do this, then come back"): a sign-in, a
 * developer console, a payment, a device. An agent ends its reply with one block on lines of its own,
 * one step per line, Markdown links allowed:
 *
 *   <steps>
 *   1. Open [the developer console](https://developers.example.com/apps) and create an app.
 *   2. Turn on the Threads API under Use cases.
 *   </steps>
 *
 * The block is taken out of the reply's text, and the chat shows the steps as a card instead, a box to
 * tick for each; the reply asks the user, as one that ends with `ASK_TOKEN` does, and their answer is
 * an ordinary message that says which steps they did (`stepsAnswerText()`).
 *
 * Read tolerantly: numbers or bullets before the steps (`1.`, `1)`, `-`, `- [ ]`, `1、`), lines that go
 * on a step (an unmarked line, or a deeper bullet, under a marked one), Markdown emphasis or a backtick
 * around the tags, a code fence that holds the block alone, the closing tag on the last step's line, or
 * none at all (the block then runs to the end of the reply). Text after the block stays in the reply.
 * A block among other code, one that runs across a fence, one with no step, more than
 * `STEPS_LIMITS.steps` steps or more than `STEPS_LIMITS.blockChars` characters stays as text, as it was
 * written. Pure, shared by the server and the UI.
 */

/** A fence line: up to three spaces, then three or more backticks or tildes (in group 1). */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
/** A line that opens a block: the tag at its start (after up to three spaces and Markdown marks), and what follows it (group 1). */
const OPEN = /^[ \t]{0,3}[*_`]{0,3}<steps(?:\s[^>\n]*)?>[*_`]{0,3}(.*)$/i;
/** The closing tag, with the Markdown marks around it. */
const CLOSE = /[*_`]{0,3}<\/steps\s*>[*_`]{0,3}/i;
/** The ask marker: a reply with steps asks already, so a marker among them is no step's words. */
const ASK = /[*_`]*\[ASK_USER\][*_`]*/gi;
/** A step's number or bullet at the start of its line. */
const MARKER =
  /^(?:\d{1,3}[.)]|\(\d{1,3}\)|[-*+•])(?:[ \t]+|$)|^\d{1,3}[、．:：][ \t]*|^(?:step|步驟)[ \t]*\d{1,3}[ \t]*[.:：)、][ \t]*|^第[ \t]*\d{1,3}[ \t]*步[ \t]*[.:：、]?[ \t]*/i;
/** A task box after the marker (`- [ ] …`): the user ticks the card's box instead. */
const TASK_BOX = /^\[[ xX]\][ \t]+/;

const blank = (line: string) => !line.trim();

/** How far in a line starts, a tab counting four. */
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length;

/** The line that closes the fence opened by `mark` at `at`, or `lines.length` when none does. */
function fenceClose(lines: readonly string[], at: number, mark: string): number {
  for (let i = at + 1; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]!);
    if (m && m[1]![0] === mark[0] && m[1]!.length >= mark.length && blank(lines[i]!.trim().slice(m[1]!.length))) return i;
  }
  return lines.length;
}

/**
 * The block whose opening tag starts line `at`, read up to line `stop` (not included): its lines, where
 * it ends, what follows its closing tag on that line, and whether it closed. Undefined when the line opens
 * none, or the block runs across a fence or into another opening tag.
 */
function readBlock(
  lines: readonly string[],
  at: number,
  stop: number,
): { end: number; body: string[]; after: string; closed: boolean } | undefined {
  const open = OPEN.exec(lines[at]!);
  if (!open) return undefined;
  const body: string[] = [];
  for (let j = at; j < stop; j++) {
    const line = j === at ? open[1]! : lines[j]!;
    if (j > at && (FENCE.test(line) || OPEN.test(line))) return undefined;
    const close = CLOSE.exec(line);
    if (close) {
      body.push(line.slice(0, close.index));
      return { end: j, body, after: line.slice(close.index + close[0].length), closed: true };
    }
    body.push(line);
  }
  return { end: stop - 1, body, after: '', closed: false };
}

/**
 * A block's lines as steps: each marked line starts one (all of them, when none is marked); an unmarked
 * line, or a marked one indented deeper than the steps' own markers, goes on the step before it.
 */
function stepsOf(body: readonly string[]): string[] {
  const lines = body.map((l) => l.replace(ASK, '').trimEnd()).filter((l) => !blank(l));
  const marks = lines.map((l) => MARKER.exec(l.trim()));
  const marked = lines.filter((_, i) => marks[i]);
  const base = marked.length ? Math.min(...marked.map(indentOf)) : 0;
  const steps: string[] = [];
  lines.forEach((line, i) => {
    const mark = marks[i];
    const own = marked.length === 0 || (mark !== null && indentOf(line) <= base + 1);
    const text = line.trim();
    if (own || steps.length === 0) {
      const words = (mark ? text.slice(mark[0].length) : text).replace(TASK_BOX, '').trim();
      if (words) steps.push(words);
    } else {
      steps[steps.length - 1] += `\n${text}`;
    }
  });
  return steps;
}

/**
 * A reply's text without its steps block, and the steps (`steps` absent when it has none, or one that
 * stays text: see the top of this file). The last block of the reply counts.
 */
export function splitSteps(text: string): { text: string; steps?: string[] } {
  if (!/<steps\b/i.test(text)) return { text };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let found: { start: number; end: number; body: string[]; after: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]!);
    if (fence) {
      // Code, unless the fence holds a block and nothing else: then the block, fence and all.
      const close = fenceClose(lines, i, fence[1]!);
      let inner = i + 1;
      while (inner < close && blank(lines[inner]!)) inner++;
      const block = close < lines.length && inner < close ? readBlock(lines, inner, close) : undefined;
      if (block && !block.after.trim() && lines.slice(block.end + 1, close).every(blank)) {
        found = { start: i, end: close, body: block.body, after: '' };
      }
      i = close;
      continue;
    }
    const block = readBlock(lines, i, lines.length);
    if (block) {
      found = { start: i, end: block.end, body: block.body, after: block.after };
      i = block.end;
    }
  }
  if (!found) return { text };
  const steps = stepsOf(found.body);
  if (!steps.length || steps.length > STEPS_LIMITS.steps || found.body.join('\n').length > STEPS_LIMITS.blockChars) return { text };
  const before = lines.slice(0, found.start).join('\n').trimEnd();
  const after = [found.after, ...lines.slice(found.end + 1)].join('\n').trim();
  return { text: [before, after].filter(Boolean).join('\n\n'), steps };
}

/** A block opening at a line's start, as it streams (the tag may still be cut short: `<ste`). */
const OPEN_START = /^[ \t]{0,3}[*_`]{0,3}<steps(?=[\s>]|$)/i;
const OPEN_TYPED = /^[ \t]{0,3}[*_`]{0,3}<s(?:t(?:e(?:p(?:s)?)?)?)?$/i;

/**
 * A reply's text while it streams: without a steps block that has begun at a line's start (finished or
 * not), and the code fence it may be in, which come out once the reply ends.
 */
export function withoutStepsTail(text: string): string {
  if (!text.includes('<')) return text;
  const lines = text.split('\n');
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPEN_START.test(lines[i]!) || (i === lines.length - 1 && OPEN_TYPED.test(lines[i]!))) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return text;
  if (cut > 0 && FENCE.test(lines[cut - 1]!)) cut--;
  return lines.slice(0, cut).join('\n').trimEnd();
}

export type StepsPart = Extract<MessagePart, { type: 'steps' }>;

/** A message's steps card, when it has one. */
export function stepsOfMessage(m: Pick<ChatMessage, 'parts'>): StepsPart | undefined {
  return m.parts.find((p): p is StepsPart => p.type === 'steps');
}

/** The steps as agents read them in the chat: the block the agent wrote, one numbered step a line. */
export function stepsBlock(items: readonly StepItem[]): string {
  return `<steps>\n${items.map((s, i) => `${i + 1}. ${indented(s.text)}`).join('\n')}\n</steps>`;
}

/** A step's later lines indented, so that they stay in its numbered item. */
const indented = (text: string) => text.replace(/\n/g, '\n   ');

/** `text` with the @ of each mention of `names` taken out: words quoted from an agent address no one. */
export function unmention(text: string, names: readonly string[]): string {
  if (!text.includes('@') || !mentionsInMarkdown(text, [...names]).length) return text;
  let out = '';
  let last = 0;
  for (const m of findMentions(text, [...names])) {
    out += text.slice(last, m.start) + text.slice(m.start + 1, m.end);
    last = m.end;
  }
  return out + text.slice(last);
}

/** The words of the user's answer, in their language (the server's `t().steps`). */
export interface StepsWords {
  /** Its first line: who gave the steps (`@name`), how many the user did of how many, and the step they are stuck at (from 1). */
  summary: (o: { agent: string; done: number; total: number; stuckAt?: number }) => string;
  done: string;
  notDone: string;
  stuck: string;
  /** Before the user's note, with what separates it ("Note: "). */
  note: string;
}

/**
 * The user's answer to a steps card, as their message says it: how it went, each step marked done, not
 * done or where they are stuck, and their note. Mentions in the agent's steps lose their @, so that the
 * answer goes to the agent that asked (named in `agent`), as an answer to its question would.
 */
export function stepsAnswerText(
  o: { agent: string; items: readonly StepItem[]; stuckAt?: number; note?: string; names: readonly string[] },
  w: StepsWords,
): string {
  const stuck = o.stuckAt !== undefined && o.stuckAt >= 0 && o.stuckAt < o.items.length ? o.stuckAt : undefined;
  const done = o.items.filter((s, i) => s.done && i !== stuck).length;
  const lines = o.items.map((s, i) => {
    const mark = i === stuck ? w.stuck : s.done ? w.done : w.notDone;
    return `${i + 1}. [${mark}] ${indented(unmention(s.text, o.names))}`;
  });
  const note = o.note?.trim();
  const summary = w.summary({ agent: o.agent, done, total: o.items.length, ...(stuck !== undefined ? { stuckAt: stuck + 1 } : {}) });
  return [summary, lines.join('\n'), note ? `${w.note}${note}` : ''].filter(Boolean).join('\n\n');
}
