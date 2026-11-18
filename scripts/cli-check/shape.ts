/**
 * What `scripts/cli-check.ts` records of a CLI, reduced to what an adapter relies on: the kinds of
 * messages it sends and is sent, the keys each holds, their value types, and the values of the fields
 * that say what a message is (`type`, `sessionUpdate`, `stopReason`…), never the text. Two versions
 * of a CLI that say different things in the same way have the same shape; a renamed method, a key
 * gone, a new kind of update or a number that became a string show up in `diffShapes`.
 *
 * A recording is every process started while recording (`recordSpawns` in `src/server/process.ts`),
 * with what went through its stdin and stdout: JSON lines (ACP, Codex's app-server, Claude Code's
 * stream-json, Pi's RPC) or Content-Length frames (Copilot's headless server).
 */
import { StringDecoder } from 'node:string_decoder';
import type { SpawnRecorder } from '../../src/server/process';

export interface Spawned {
  bin: string;
  args: readonly string[];
  cwd?: string;
  stdin: string;
  stdout: string;
  stderr: string;
  exit?: { code: number | null; signal: string | null };
}

/**
 * A recorder that keeps every process's stdio as text, each stream decoded as one (a character split
 * between two chunks is kept whole: Content-Length frames count bytes).
 */
export function memoryRecorder(): { recorder: SpawnRecorder; spawned: Spawned[] } {
  const spawned: Spawned[] = [];
  const recorder: SpawnRecorder = {
    start: (o) => {
      const s: Spawned = { bin: o.bin, args: [...o.args], ...(o.cwd ? { cwd: o.cwd } : {}), stdin: '', stdout: '', stderr: '' };
      const decoders = { stdin: new StringDecoder('utf8'), stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      spawned.push(s);
      return {
        data: (stream, chunk) => {
          s[stream] += decoders[stream].write(chunk);
        },
        exit: (code, signal) => {
          for (const stream of ['stdin', 'stdout', 'stderr'] as const) s[stream] += decoders[stream].end();
          s.exit = { code, signal };
        },
      };
    },
  };
  return { recorder, spawned };
}

export type Direction = 'to-cli' | 'from-cli';

export interface Message {
  dir: Direction;
  msg: Record<string, unknown>;
}

/** The JSON messages of one stream: JSON lines, or Content-Length frames. */
export function messagesOf(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (/^Content-Length:/i.test(text.trimStart())) {
    let rest = text;
    for (;;) {
      const head = /Content-Length:\s*(\d+)\r?\n(?:[^\r\n]*\r?\n)*?\r?\n/i.exec(rest);
      if (!head) break;
      const start = head.index + head[0].length;
      const len = Number(head[1]);
      const body = Buffer.from(rest.slice(start), 'utf8').subarray(0, len).toString('utf8');
      try {
        const j = JSON.parse(body);
        if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j);
      } catch {
        /* not a message */
      }
      rest = rest.slice(start + body.length);
    }
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j);
    } catch {
      /* a line of text */
    }
  }
  return out;
}

/** The fields whose values say what a message or a part of it is: kept in a shape, as `path=value`. */
const ENUM_KEYS = new Set([
  'type',
  'subtype',
  'kind',
  'method',
  'status',
  'stopReason',
  'stop_reason',
  'sessionUpdate',
  'role',
  'optionId',
  'outcome',
  'decision',
  'behavior',
  'mode',
  'modeId',
  'permissionMode',
  'currentModeId',
  'protocolVersion',
  'name',
]);

/** Values of `ENUM_KEYS` that are words, not text: anything longer or with spaces is left out. */
const ENUM_VALUE = /^[\w./:@+-]{1,48}$/;

/** Where a message says which kind it is, beyond its method or type, in this order. */
const REFINE = [
  'params.update.sessionUpdate',
  'params.item.type',
  'params.msg.type',
  'request.subtype',
  'response.subtype',
  'event.type',
  'subtype',
];

const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

/**
 * Keys that are names, not fields (a map of sessions, models, files, servers, a run's own profile):
 * the shape keeps them as one `*`, so that two recordings with other names have the same shape.
 */
function dynamicKeys(keys: string[]): boolean {
  // A long run of hex digits is an id, also inside a name: Codex's permission profile is `harness-relay-<16 hex>`, new each run.
  return keys.length > 100 || keys.some((k) => k.length > 40 || /[/\\\s@]|^\d|[0-9a-f]{12,}/i.test(k));
}

/** A value's shape as paths: `a.b:string`, `a.list[].type=text`, `a.map.*:number`. */
export function pathsOf(value: unknown, prefix = '', key = '', out: Set<string> = new Set()): Set<string> {
  const here = prefix || '.';
  if (value === null) out.add(`${here}:null`);
  else if (Array.isArray(value)) {
    if (!value.length) out.add(`${here}:[]`);
    for (const v of value) pathsOf(v, `${prefix}[]`, key, out);
  } else if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    if (!keys.length) out.add(`${here}:{}`);
    const dynamic = dynamicKeys(keys);
    for (const k of keys) {
      pathsOf((value as Record<string, unknown>)[k], prefix ? `${prefix}.${dynamic ? '*' : k}` : dynamic ? '*' : k, dynamic ? '*' : k, out);
    }
  } else if (typeof value === 'string' && ENUM_KEYS.has(key) && ENUM_VALUE.test(value)) out.add(`${here}=${value}`);
  else out.add(`${here}:${typeof value}`);
  return out;
}

/** The kind of each message of one exchange: its direction, method or type, and what refines it. */
export function kindsOf(messages: readonly Message[]): string[] {
  // Which method each request id is, by the side that sent it: an answer is named after it.
  const asked: Record<Direction, Map<string, string>> = { 'to-cli': new Map(), 'from-cli': new Map() };
  // Claude Code's control requests, by their request_id, from either side.
  const controls = new Map<string, string>();
  return messages.map(({ dir, msg }) => {
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    const id = msg.id === undefined || msg.id === null ? undefined : String(msg.id);
    let base: string;
    if (msg.type === 'control_request' && typeof msg.request_id === 'string') {
      const sub = at(msg, 'request.subtype');
      controls.set(msg.request_id, typeof sub === 'string' ? sub : '?');
      return `${dir} control_request:${typeof sub === 'string' ? sub : '?'}`;
    }
    const answered = at(msg, 'response.request_id');
    if (msg.type === 'control_response' && typeof answered === 'string') {
      const sub = at(msg, 'response.subtype');
      return `${dir} control_response:${controls.get(answered) ?? '?'}${sub === 'error' ? ':error' : ''}`;
    }
    if (method) {
      if (id !== undefined) asked[dir].set(id, method);
      base = method;
    } else if (id !== undefined && ('result' in msg || 'error' in msg)) {
      const other: Direction = dir === 'to-cli' ? 'from-cli' : 'to-cli';
      base = `${asked[other].get(id) ?? '?'} ${'error' in msg ? 'error' : 'result'}`;
    } else if (typeof msg.type === 'string') base = msg.type;
    else base = '?';
    for (const path of REFINE) {
      const v = at(msg, path);
      if (typeof v === 'string' && ENUM_VALUE.test(v) && !(path === 'subtype' && base.endsWith(`:${v}`))) {
        base += `:${v}`;
        break;
      }
    }
    return `${dir} ${base}`;
  });
}

export interface Shape {
  /** Each kind of message, with its paths. */
  kinds: Record<string, string[]>;
  /** The flags the CLI's help lists (layer 2 only). */
  flags?: string[];
  /** What the server's own code made of the CLI's answers (layer 2: status, models…), as paths. */
  results?: Record<string, string[]>;
}

/** The shape of every exchange recorded: its messages, by kind. */
export function shapeOf(spawned: readonly Spawned[]): Shape {
  const kinds: Record<string, Set<string>> = {};
  for (const s of spawned) {
    const messages: Message[] = [
      ...messagesOf(s.stdin).map((msg) => ({ dir: 'to-cli' as const, msg })),
      ...messagesOf(s.stdout).map((msg) => ({ dir: 'from-cli' as const, msg })),
    ];
    // In the order they were said: requests before their answers (an answer names its request's method).
    const ordered = interleave(messages);
    const names = kindsOf(ordered);
    ordered.forEach(({ msg }, i) => {
      const k = names[i]!;
      pathsOf(msg, '', '', (kinds[k] ??= new Set()));
    });
  }
  return { kinds: sortRecord(kinds) };
}

/**
 * Messages as they were said, as near as two separate streams tell: a request before the answers with
 * its id, from either side. Within each stream the order is kept.
 */
function interleave(messages: readonly Message[]): Message[] {
  const toCli = messages.filter((m) => m.dir === 'to-cli');
  const fromCli = messages.filter((m) => m.dir === 'from-cli');
  const out: Message[] = [];
  const seen: Record<Direction, Set<string>> = { 'to-cli': new Set(), 'from-cli': new Set() };
  const answers = (m: Message) => !m.msg.method && m.msg.id !== undefined && m.msg.id !== null;
  let i = 0;
  let j = 0;
  while (i < toCli.length || j < fromCli.length) {
    const a = toCli[i];
    const b = fromCli[j];
    // Take an answer only once the request it answers was taken.
    const ready = (m: Message | undefined) =>
      !!m && (!answers(m) || seen[m.dir === 'to-cli' ? 'from-cli' : 'to-cli'].has(String(m.msg.id)));
    const take = (m: Message) => {
      out.push(m);
      if (m.msg.method && m.msg.id !== undefined && m.msg.id !== null) seen[m.dir].add(String(m.msg.id));
    };
    if (a && ready(a)) take(toCli[i++]!);
    else if (b && ready(b)) take(fromCli[j++]!);
    else if (a) take(toCli[i++]!);
    else take(fromCli[j++]!);
  }
  return out;
}

function sortRecord(r: Record<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries(
    Object.keys(r)
      .sort()
      .map((k) => [k, [...r[k]!].sort()]),
  );
}

/** The long flags a help text lists. */
export function flagsOf(help: string): string[] {
  const out = new Set<string>();
  for (const m of help.matchAll(/(?:^|[\s,[(|])(--[a-z][a-z0-9-]*[a-z0-9])/gim)) out.add(m[1]!.toLowerCase());
  return [...out].sort();
}

/** The flags `argv` passes (`--name` or `--name=value`). */
export function flagsIn(argv: readonly string[]): string[] {
  return [...new Set(argv.filter((a) => /^--[a-z]/i.test(a)).map((a) => a.split('=')[0]!.toLowerCase()))].sort();
}

export interface ShapeDiff {
  /** Kinds of message only the new recording has. */
  newKinds: string[];
  /** Kinds only the saved shape has: maybe gone, maybe not said this time. */
  goneKinds: string[];
  /** Paths each kind (or result) gained and lost. */
  changed: { kind: string; added: string[]; removed: string[] }[];
  flagsAdded: string[];
  flagsRemoved: string[];
}

export function diffShapes(saved: Shape, now: Shape): ShapeDiff {
  const changed: ShapeDiff['changed'] = [];
  const compare = (a: Record<string, string[]>, b: Record<string, string[]>, prefix = '') => {
    for (const k of Object.keys(b)) {
      if (!a[k]) continue;
      const before = new Set(a[k]);
      const after = new Set(b[k]);
      const added = [...after].filter((p) => !before.has(p));
      const removed = [...before].filter((p) => !after.has(p));
      if (added.length || removed.length) changed.push({ kind: prefix + k, added, removed });
    }
  };
  compare(saved.kinds, now.kinds);
  compare(saved.results ?? {}, now.results ?? {}, 'result ');
  const newKinds = [
    ...Object.keys(now.kinds).filter((k) => !saved.kinds[k]),
    ...Object.keys(now.results ?? {})
      .filter((k) => !saved.results?.[k])
      .map((k) => `result ${k}`),
  ];
  const goneKinds = [
    ...Object.keys(saved.kinds).filter((k) => !now.kinds[k]),
    ...Object.keys(saved.results ?? {})
      .filter((k) => !now.results?.[k])
      .map((k) => `result ${k}`),
  ];
  const [fa, fb] = [new Set(saved.flags ?? []), new Set(now.flags ?? [])];
  return {
    newKinds,
    goneKinds,
    changed,
    flagsAdded: saved.flags ? [...fb].filter((f) => !fa.has(f)) : [],
    flagsRemoved: now.flags ? [...fa].filter((f) => !fb.has(f)) : [],
  };
}

export function sameShape(d: ShapeDiff): boolean {
  return !d.newKinds.length && !d.goneKinds.length && !d.changed.length && !d.flagsAdded.length && !d.flagsRemoved.length;
}

/** A diff as lines for the report, most telling first: what is gone, then what is new. */
export function describeDiff(d: ShapeDiff, max = 40): string[] {
  const lines: string[] = [];
  for (const f of d.flagsRemoved) lines.push(`- flag ${f} (its help no longer lists it)`);
  for (const k of d.goneKinds) lines.push(`- ${k} (not seen this time)`);
  for (const c of d.changed) for (const p of c.removed) lines.push(`- ${c.kind}: ${p}`);
  for (const k of d.newKinds) lines.push(`+ ${k} (new)`);
  for (const c of d.changed) for (const p of c.added) lines.push(`+ ${c.kind}: ${p}`);
  for (const f of d.flagsAdded) lines.push(`+ flag ${f}`);
  return lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more`] : lines;
}
