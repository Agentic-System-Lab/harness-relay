/*
 * What a shell command line runs: the programs and their arguments, for "always allow" rule keys and
 * for spotting commands that push or publish. Best effort, not a shell parser. It handles the forms
 * CLIs and models commonly use: chains, pipes, background jobs, `$( )` / backtick substitutions,
 * `sh -c '…'`, heredocs, redirections, line continuations, `VAR=value` assignments, wrappers such as
 * `env` or `timeout`, paths to programs, and git's global options. When unsure it errs toward keys
 * that match less (so approvals ask more), never more.
 *
 * There are two readings, and callers use both (a push either one finds asks; the rule keys are those
 * of both): `parseCommandLine` reads each command literally, so `if git push` is the program `if`;
 * `parseShellSyntax` also reads the shell's own syntax around commands (reserved words, `!`, compound
 * commands, function bodies, `eval`, heredocs given to a shell), so it finds `git push` there. Each is a floor for the other: a
 * change to the second can only make the checks stricter.
 */

/** `/bin/zsh -lc 'npm test'` → `npm test` (shell wrappers that CLIs add), for display. */
export function unwrapShell(command: string): string {
  const m = command.trim().match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-\w+\s+)*-\w*c\w*\s+(['"])([\s\S]*)\1$/);
  return m ? m[2]!.replace(/\\(['"\\])/g, '$1') : command.trim();
}

/** Marks where a command substitution stood in a word: its value is only known when it runs. */
const DYNAMIC = '\u0000';
/** Deeper nesting of substitutions is refused (callers then fall back to asking). */
const MAX_DEPTH = 32;

/** A heredoc's delimiter, and the index in `parts` of the command it belongs to once that ends. */
interface Heredoc {
  word: string;
  strip: boolean;
  /** Unquoted delimiter: the shell expands the body, running its `$( )` and backticks. */
  expands: boolean;
  part: number;
}
/** A heredoc's body, and the index in `parts` of the command it is given to. */
interface Body {
  part: number;
  text: string;
  expands: boolean;
}
/** What `scan` notes besides the commands: heredoc bodies, and whether output goes into another command. */
interface Scanned {
  bodies: Body[];
  /** A pipe (`|`, `|&`, not `||`) or a process substitution (`<( )`, `>( )`). */
  piped: boolean;
}

/**
 * Split a command line into the text of its simple commands. Separators (`;`, `|`, `&`, newlines,
 * `( )`, `{ }`) count outside quotes only; `>&` / `&>` are redirections, not separators. Command
 * substitutions run commands of their own (also inside double quotes), so their content is split out
 * as well and the substitution is left as a DYNAMIC placeholder. Heredoc bodies are skipped (and
 * collected in `bodies`). With `inSubst`, scanning stops at the `)` closing the substitution; returns
 * the index reached.
 */
function scan(line: string, start: number, inSubst: boolean, parts: string[], depth = 0, notes: Scanned = { bodies: [], piped: false }): number {
  if (depth > MAX_DEPTH) throw new Error('command nesting too deep');
  let cur = '';
  let quote: '"' | "'" | null = null;
  let groups = 0; // plain `( )` groups inside a substitution
  const heredocs: Heredoc[] = [];
  let own: Heredoc[] = []; // the heredocs of the command being read
  const end = () => {
    for (const h of own) h.part = parts.length;
    own = [];
    parts.push(cur);
    cur = '';
  };
  for (let i = start; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
    } else if (ch === '\\' && i + 1 < line.length) {
      if (line[i + 1] === '\n') i++; // line continuation
      else cur += ch + line[++i];
    } else if (quote === null && ch === '#' && (i === 0 || /[\s;|&(){}]/.test(line[i - 1]!))) {
      // A comment runs to the end of the line (quotes, `<<` and `\` in it mean nothing).
      const nl = line.indexOf('\n', i);
      i = (nl < 0 ? line.length : nl) - 1;
    } else if (quote === null && ch === '$' && line[i + 1] === "'") {
      // ANSI-C quoting `$'…'`: a backslash escapes the next character, also a quote.
      let j = i + 2;
      while (j < line.length && line[j] !== "'") j += line[j] === '\\' ? 2 : 1;
      cur += line.slice(i, j + 1);
      i = j;
    } else if (ch === '`') {
      let j = i + 1;
      let inner = '';
      while (j < line.length && line[j] !== '`') {
        if (line[j] === '\\' && j + 1 < line.length) {
          inner += line[j + 1];
          j += 2;
        } else inner += line[j++];
      }
      scan(inner, 0, false, parts, depth + 1, notes);
      cur += DYNAMIC;
      i = j;
    } else if (ch === '$' && line[i + 1] === '(') {
      i = scan(line, i + 2, true, parts, depth + 1, notes);
      cur += DYNAMIC;
    } else if (quote === '"') {
      cur += ch;
      if (ch === '"') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '<' && line.startsWith('<<<', i)) {
      cur += '<<<'; // a here-string, not a heredoc
      i += 2;
    } else if (ch === '<' && line[i + 1] === '<') {
      // Heredoc: remember its delimiter; the body starts on the next line and is not commands.
      const m = /^<<(-?)\s*([^\s;|&<>()]+)/.exec(line.slice(i));
      if (m) {
        const h = { word: m[2]!.replace(/['"\\]/g, ''), strip: m[1] === '-', expands: !/['"\\]/.test(m[2]!), part: -1 };
        heredocs.push(h);
        own.push(h);
        cur += ' ';
        i += m[0].length - 1;
      } else cur += ch;
    } else if (ch === '&' && (line[i - 1] === '>' || line[i - 1] === '<' || line[i + 1] === '>')) {
      cur += ch; // `2>&1`, `&>file`: a redirection
    } else if (ch === '\n' && heredocs.length) {
      end();
      // Skip each pending heredoc body up to its delimiter line; if a delimiter line never comes
      // (not really a heredoc, e.g. `$[1<<2]`), skip nothing.
      let j = i + 1;
      let found = true;
      const read: Body[] = [];
      for (const h of heredocs) {
        found = false;
        const from = j;
        while (j < line.length) {
          const at = j;
          const nl = line.indexOf('\n', j);
          const text = line.slice(j, nl < 0 ? line.length : nl).replace(/\r$/, '');
          j = nl < 0 ? line.length : nl + 1;
          if ((h.strip ? text.replace(/^\t+/, '') : text) === h.word) {
            found = true;
            read.push({ part: h.part, text: line.slice(from, at), expands: h.expands });
            break;
          }
        }
        if (!found) break;
      }
      heredocs.length = 0;
      if (found) {
        i = j - 1;
        notes.bodies.push(...read);
      }
    } else if (inSubst && ch === ')' && groups === 0) {
      end();
      return i;
    } else if (';|&\n(){}'.includes(ch)) {
      if ((ch === '|' && line[i - 1] !== '|' && line[i + 1] !== '|') || (ch === '(' && /[<>]/.test(line[i - 1] ?? ''))) notes.piped = true;
      if (inSubst && ch === '(') groups++;
      if (inSubst && ch === ')') groups--;
      end();
    } else {
      cur += ch;
    }
  }
  end();
  return line.length;
}

/** The command substitutions (`$( )`, backticks) in a heredoc body the shell expands: they run. */
function substitutions(body: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++;
    else if (body[i] === '`') {
      let j = i + 1;
      while (j < body.length && body[j] !== '`') j += body[j] === '\\' ? 2 : 1;
      out.push(body.slice(i + 1, j));
      i = j;
    } else if (body.startsWith('$(', i)) {
      const end = scan(body, i + 2, true, []);
      out.push(body.slice(i + 2, end));
      i = end;
    }
  }
  return out;
}

/**
 * Words of a simple command, with quotes and escapes removed and redirections (`>out`, `2>&1`,
 * `< in`) dropped: `git commit -m "a b" >log` → git, commit, -m, a b. The text of a here-string
 * (`<<< 'text'`) goes to `io.here`; `io.input` says whether standard input comes from elsewhere
 * (`< file`, `<&3`, `< <(…)`).
 */
function words(segment: string, io?: { here: string[]; input: boolean }): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false;
  let skipTarget = false; // the next word is a redirection's target
  let hereTarget = false; // … of a here-string
  const push = () => {
    if (cur || started) {
      if (skipTarget) {
        if (hereTarget) io?.here.push(cur);
        skipTarget = hereTarget = false;
      } else out.push(cur);
    }
    cur = '';
    started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += ch;
    } else if (ch === '\\' && i + 1 < segment.length) {
      cur += segment[++i];
      started = true;
    } else if (ch === '$' && segment[i + 1] === "'") {
      // `$'…'`: backslash escapes inside (`\n` and the like are kept as written).
      let j = i + 2;
      while (j < segment.length && segment[j] !== "'") {
        if (segment[j] === '\\' && j + 1 < segment.length) cur += segment[j + 1] === "'" ? "'" : segment[j]! + segment[j + 1]!;
        else cur += segment[j]!;
        j += segment[j] === '\\' ? 2 : 1;
      }
      started = true;
      i = j;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '<' || ch === '>') {
      if (io && ch === '<' && !segment.startsWith('<<<', i) && !(/^\d+$/.test(cur) && cur !== '0')) io.input = true;
      if (/^\d+$/.test(cur) || cur === '&') cur = ''; // a file descriptor: `2>`, `&>`
      push();
      const hereString = segment.startsWith('<<<', i);
      while (i + 1 < segment.length && /[<>&|]/.test(segment[i + 1]!)) i++;
      // `>&1` / `>&-` duplicate a descriptor: no file name follows.
      const dup = /^\d+|^-/.exec(segment.slice(i + 1));
      if (segment[i] === '&' && dup) i += dup[0].length;
      else {
        skipTarget = true;
        hereTarget = hereString;
      }
    } else if (/\s/.test(ch)) {
      push();
    } else {
      cur += ch;
    }
  }
  push();
  return out;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Programs that run the rest of their arguments as a command, with their options that take a value. */
const WRAPPERS: Record<string, Set<string>> = {
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  xargs: new Set(['-n', '-L', '-P', '-s', '-I', '-E', '-d', '-a']),
};
/** Wrappers that change who runs the command: kept in approval keys (`sudo rm` is not `rm`). */
const PRIVILEGED: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
};

const basename = (program: string) => program.split('/').pop() ?? program;
const isAssignment = (w: string) => /^[A-Za-z_]\w*=/.test(w);

/**
 * Words the shell reads itself in front of a command, not the program it runs: reserved words, `!`, and
 * zsh's precommand modifiers. (`time` is a wrapper above, for its `-p`; `( ) { }` already split the
 * line, see `scan`.) Ending words such as `fi` or `done` are skipped too: whatever follows them is read
 * as a command, which only makes the checks stricter.
 */
const RESERVED = new Set([
  '!', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'esac', 'in', 'coproc', 'always', 'end',
  'noglob', 'nocorrect', '-',
]);

/**
 * Takes what the shell reads itself off the front of a command's words (second reading only): a
 * reserved word, or the header of a construct, whose names, word lists and patterns do not run —
 * `for x in a b` (but `for x do cmd` runs `cmd`), `select`, zsh's `foreach`, `case word in pattern`,
 * `function name`, zsh's `repeat count`, and a `[[ … ]]` test (zsh runs what follows it after `if`).
 * Returns whether it took anything.
 */
function skipShellWords(w: string[]): boolean {
  const first = w[0];
  if (first === undefined) return false;
  if (RESERVED.has(first)) {
    w.shift();
  } else if (first === 'for' || first === 'select' || first === 'foreach') {
    const i = w.findIndex((x, k) => k > 0 && (x === 'in' || x === 'do'));
    w.splice(0, i >= 0 && w[i] === 'do' ? i + 1 : w.length);
  } else if (first === 'case') {
    w.length = 0;
  } else if (first === 'function' || first === 'repeat') {
    w.splice(0, 2);
  } else if (first === '[[') {
    const i = w.indexOf(']]');
    w.splice(0, i >= 0 ? i + 1 : w.length);
  } else {
    return false;
  }
  return true;
}

/** One simple command: the program and its arguments, plus the privilege wrappers it runs under. */
export interface SimpleCommand {
  args: string[];
  /** `sudo` / `doas` in front of it. */
  privileged: string[];
  /** The program is not known before it runs (`$(which git) push`, `$TOOL`). */
  dynamic: boolean;
  /** `VAR=value` settings it runs with (also those given to `env`). */
  assignments: string[];
  /**
   * A key that only matches this exact command: its text, or the whole command line when part of it
   * is a substitution (whose commands the text would not show).
   */
  text: string;
  /** Keyed by `text` (second reading): the line sets what decides what runs (`LD_PRELOAD`, `PATH`…). */
  exact?: boolean;
}

/** A command line another command runs (`env -S '…'`), with the privileges and settings it runs under. */
interface Nested {
  line: string;
  privileged: string[];
  assignments: string[];
}

/**
 * The program and its arguments for one simple command. `VAR=value` assignments and wrapper programs
 * (`env`, `timeout 10`…) are skipped and the program is given without its path. A wrapper that leaves
 * nothing behind (`sudo -s`) is itself the program; `env -S '…'` runs its string as a command line.
 * With `syntax` (the second reading), what the shell reads itself in front of it is skipped too.
 */
function command(segmentWords: string[], text: string, nested: Nested[], syntax: boolean): (SimpleCommand & { xargs: boolean }) | undefined {
  const w = [...segmentWords];
  const privileged: string[] = [];
  const assignments: string[] = [];
  let xargs = false; // run by xargs, with arguments it reads on standard input
  for (;;) {
    while (w.length && isAssignment(w[0]!)) assignments.push(w.shift()!);
    if (syntax && skipShellWords(w)) continue;
    const program = w.length ? basename(w[0]!) : '';
    const valued = WRAPPERS[program] ?? PRIVILEGED[program];
    if (!valued) break;
    const rest = w.slice(1);
    // `command -v rm` looks a program up; it does not run it.
    if (program === 'command' && /^-[vV]$/.test(rest[0] ?? '')) break;
    let k = 0;
    let split: string | undefined;
    while (k < rest.length && (rest[k]!.startsWith('-') || isAssignment(rest[k]!) || /^\d+[smhd]?$/.test(rest[k]!))) {
      const opt = rest[k++]!;
      if (isAssignment(opt)) assignments.push(opt);
      if (program === 'env' && (opt === '-S' || opt === '--split-string')) split = rest[k++];
      else if (program === 'env' && opt.startsWith('--split-string=')) split = opt.slice('--split-string='.length);
      else if (valued.has(opt)) k++;
    }
    if (split !== undefined) nested.push({ line: split, privileged: [...privileged], assignments: [...assignments] });
    if (k >= rest.length) break; // nothing left to run: the wrapper is the command
    if (PRIVILEGED[program]) privileged.push(program);
    if (program === 'xargs') xargs = true;
    w.splice(0, k + 1);
  }
  if (!w.length) return undefined;
  const dynamic = w[0]!.includes(DYNAMIC) || w[0]!.startsWith('$');
  w[0] = basename(w[0]!);
  return { args: w, privileged, dynamic, assignments, text: text.trim(), xargs }; // args still mark substitutions
}

/** How deep `sh -c`, `env -S` and `eval` strings are read. */
const MAX_NESTED = 3;

/**
 * How shells and interpreters are told what to run; given nothing, they run what they read on
 * standard input. `code` gives it on the command line (`-c`, `-e`, `-m`), `input` reads standard
 * input even so (`sh -s`), `valued` options take the next word, `info` ones only print something.
 */
const LAUNCH: { programs: RegExp; code: RegExp; input?: RegExp; valued: RegExp; info: RegExp }[] = [
  {
    programs: /^(sh|bash|zsh|dash|ksh|fish)$/,
    code: /^-[a-z]*c[a-z]*$|^--command(=|$)/i,
    input: /^-[a-z]*s[a-z]*$/i,
    valued: /^([-+][oO]|-C|--rcfile|--init-file|--init-command)$/,
    info: /^--(version|help)$/,
  },
  { programs: /^python[\d.]*$/, code: /^-[bBdEhiIOPqRsSuvx]*[cm]/, valued: /^-[WX]$/, info: /^(-V|--version|-h|--help|-\?)$/ },
  {
    programs: /^(node|nodejs)$/,
    code: /^(-[epc]|--eval|--print|--check|--test|--run)(=|$)/,
    valued: /^(-r|--require|--import|--loader|--experimental-loader|-C|--conditions)$/,
    info: /^(-v|--version|-h|--help)$/,
  },
  { programs: /^perl$/, code: /^-[lnpaw0-9]*[eE]$/, valued: /^-[IM]$/, info: /^(-v|-V|-h)$/ },
  { programs: /^ruby$/, code: /^-[nplaw]*e$/, valued: /^-[IrCE]$/, info: /^(-v|--version|-h|--help)$/ },
];

/**
 * xargs running a shell or interpreter, read from the raw text: `xargs -I{} sh -c '…'` is split at
 * the braces, so the command it runs is not in its words.
 */
const XARGS_RUNS_CODE = /(^|[^\w-])xargs\s[^|;&\n]*?(^|[\s/'"])(sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|nodejs|perl|ruby)(?=$|[\s'";|&)])/m;

/** Whether one of them is a program that runs what it reads on standard input (`… | sh`, `| python3 -`). */
function runsInput(args: string[]): boolean {
  const launch = LAUNCH.find((l) => l.programs.test(args[0] ?? ''));
  if (!launch) return false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-') return true; // standard input named as the script
    if (a === '--') return i + 1 >= args.length;
    if (launch.info.test(a) || launch.code.test(a)) return false;
    if (launch.input?.test(a)) return true;
    if (launch.valued.test(a)) i++;
    else if (!/^[-+]/.test(a)) return false; // a script file
  }
  return true;
}

/**
 * Settings that change what a command runs or how: the loader, the search path, shell and
 * interpreter start-up, git's and npm's configuration. A line that sets one is keyed by its text.
 */
const RUNS_ENV = /^(LD_\w+|DYLD_\w+|PATH|BASH_ENV|ENV|ZDOTDIR|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|NODE_OPTIONS|NODE_PATH|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|GIT_\w+|npm_config_\w+|PROMPT_COMMAND)\+?=/i;

/**
 * Every simple command in `line` (a part of `top`, the whole command line, at `depth` > 0). The first
 * reading stops at MAX_NESTED; the second refuses (callers then ask), as it does for a shell or
 * interpreter running what it reads on standard input (`curl … | bash`) or under xargs. The second
 * also gives the commands it finds inside `sudo sh -c '…'` (or `X=1 sh -c '…'`) the privileges and
 * settings they run under, reads the substitutions in a heredoc the shell expands, and keys every
 * command by the whole line when the line sets what decides what runs (RUNS_ENV).
 */
function read(line: string, depth: number, syntax: boolean, top: string): SimpleCommand[] {
  const parts: string[] = [];
  const notes: Scanned = { bodies: [], piped: false };
  scan(line, 0, false, parts, 0, notes);
  const out: SimpleCommand[] = [];
  let exact = false;
  if (syntax && XARGS_RUNS_CODE.test(line)) throw new Error('runs what xargs reads');
  const inner = (text: string, outer: Nested | SimpleCommand): SimpleCommand[] => {
    if (depth >= MAX_NESTED) {
      if (syntax) throw new Error('command nesting too deep');
      return [];
    }
    const cmds = read(text, depth + 1, syntax, top);
    if (!syntax || (!outer.privileged.length && !outer.assignments.length)) return cmds;
    // Keyed by the whole line: what the settings do to a command is not in its own text.
    return cmds.map((c) => ({
      ...c,
      privileged: [...outer.privileged, ...c.privileged],
      assignments: [...outer.assignments, ...c.assignments],
      text: top.trim(),
    }));
  };
  for (const [index, part] of parts.entries()) {
    const nested: Nested[] = [];
    const io = { here: [] as string[], input: false };
    const partWords = words(part, io);
    const bodies = notes.bodies.filter((b) => b.part === index);
    if (syntax) {
      if (partWords.some((w) => RUNS_ENV.test(w))) exact = true;
      for (const b of bodies) if (b.expands) for (const sub of substitutions(b.text)) out.push(...read(sub, depth, syntax, top));
    }
    const found = command(partWords, part.includes(DYNAMIC) ? (syntax ? top : line) : part, nested, syntax);
    for (const n of nested) out.push(...inner(n.line, n));
    if (!found) continue;
    const { xargs, ...simple } = found;
    const cmd: SimpleCommand = { ...simple, args: found.args.map((x) => x.replaceAll(DYNAMIC, '')) };
    // A string run as a command line; the second reading keeps where substitutions stood in it
    // (`eval "$(…)"` runs a program only known when it runs).
    const script = (from: number, to = from + 1) => (syntax ? found.args : cmd.args).slice(from, to).join(' ');
    // A program only known when it runs (`$TOOL`, set earlier in the line): keyed by the whole line.
    if (syntax && cmd.dynamic) cmd.text = top.trim();
    // `sh -c 'script'`: options before the first other word; `bash ./script.sh -c x` runs a script.
    // The second reading also takes a program only known when it runs for a shell (`$SHELL -c '…'`).
    const shell = SHELLS.has(cmd.args[0]!) || (syntax && cmd.dynamic);
    let c = -1;
    if (shell) {
      for (let i = 1; i < cmd.args.length && cmd.args[i]!.startsWith('-'); i++) {
        if (/^-[a-z]*c[a-z]*$/i.test(cmd.args[i]!)) c = i;
      }
    }
    const runs: SimpleCommand[] = [];
    if (c > 0 && cmd.args[c + 1] !== undefined && (syntax || !cmd.privileged.length)) runs.push(...inner(script(c + 1), cmd));
    // `eval` runs its arguments, joined, as a command line.
    else if (syntax && cmd.args[0] === 'eval' && cmd.args.length > 1) runs.push(...inner(script(1, cmd.args.length), cmd));
    if (syntax) {
      // A shell runs what a heredoc or here-string gives it (`bash <<'EOF'`, `sh <<< '…'`); what it
      // reads from a pipe, a file or xargs cannot be read here.
      const given = [...bodies.map((b) => b.text), ...io.here];
      const program = cmd.args[0] ?? '';
      if (xargs && (SHELLS.has(program) || LAUNCH.some((l) => l.programs.test(program)))) throw new Error('runs what xargs reads');
      if (!given.length && (notes.piped || io.input) && (runsInput(cmd.args) || (cmd.dynamic && c < 0))) {
        throw new Error('runs what it reads on standard input');
      }
      if (shell) for (const text of given) runs.push(...inner(text, cmd));
    }
    // A `-c` script with no command in it (`sh -c '{}'` under xargs) is still the shell running something;
    // in the second reading, so is a program only known when it runs.
    out.push(...runs);
    if (!runs.length || (syntax && cmd.dynamic)) out.push(cmd);
  }
  return exact ? out.map((c) => ({ ...c, exact: true, text: top.trim() })) : out;
}

/**
 * Every simple command in a command line, each read literally (`if git push` is the program `if`);
 * `sh -c '…'` and `env -S '…'` are read recursively. The first reading: see `parseShellSyntax`.
 */
export function parseCommandLine(line: string): SimpleCommand[] {
  return read(line, 0, false, line);
}

/**
 * Every simple command in a command line, reading the shell's syntax around them as well: reserved
 * words and `!` in front of a command (`if ! git push; then …` runs `git push`), the bodies of
 * `if` / `while` / `until` / `for` / `select` / `case`, `{ }` / `( )` groups, `coproc` and functions,
 * what `eval` runs, and what a heredoc or here-string gives a shell (`bash <<'EOF'`). Throws for a line
 * it cannot follow (callers then ask). Use it together with `parseCommandLine`, never instead of it.
 */
export function parseShellSyntax(line: string): SimpleCommand[] {
  return read(line, 0, true, line);
}

/** Every simple command in a command line, as program + arguments. */
export function simpleCommands(line: string): string[][] {
  return parseCommandLine(line).map((c) => [...c.privileged, ...c.args]);
}

/** git's global options that take a value (`git -C dir push`). */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
/** git global options that can make git run arbitrary programs. */
const GIT_RUNS_CODE = /^(-c|--config-env|--exec-path)(=|$)/;
/** Environment settings that can do the same (`GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`…). */
const GIT_ENV = /^GIT_\w*=/;

/** The subcommand of a git command, skipping global options (`git -C . --no-pager push` → push). */
export function gitSubcommand(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (GIT_VALUED.has(a)) i++;
    else if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/**
 * The approval rule key for one command: the program, plus its subcommand for tools that have them
 * (`npm install`, `git push`), behind any `sudo` / `doas`. A command whose program is only known when
 * it runs, or a git command with options that can run code (`-c`), is keyed by its full text.
 */
export function approvalKey(cmd: SimpleCommand, withSubcommands: Set<string>): string | undefined {
  if (cmd.dynamic || cmd.exact) return cmd.text;
  const [program, ...rest] = cmd.args;
  if (!program) return undefined;
  if (program === 'git' && (rest.some((a) => GIT_RUNS_CODE.test(a)) || cmd.assignments.some((a) => GIT_ENV.test(a)))) {
    return cmd.text;
  }
  const sub = program === 'git' ? gitSubcommand(cmd.args) : rest[0];
  const key = withSubcommands.has(program) && sub && /^[a-z][\w:-]*$/i.test(sub) ? `${program} ${sub}` : program;
  return [...cmd.privileged, key].join(' ');
}

const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'gem', 'uv', 'hatch', 'flit', 'deno', 'jsr']);

/** Whether one simple command pushes or publishes outside this machine. */
function publishes(cmd: SimpleCommand): boolean {
  const [program, ...rest] = cmd.args;
  // Unknown program (`$(which git) push`): judge by its arguments.
  if (cmd.dynamic) return rest.includes('push') || rest.includes('publish');
  if (!program) return false;
  if (program === 'git') return gitSubcommand(cmd.args) === 'push';
  if (PUBLISHERS.has(program)) return rest.includes('publish') || (program === 'gem' && rest[0] === 'push');
  if (program === 'twine') return rest[0] === 'upload';
  if (program === 'docker' || program === 'podman') return rest[0] === 'push';
  if (program === 'gh') return rest[0] === 'release' || (rest[0] === 'pr' && ['create', 'merge'].includes(rest[1] ?? ''));
  return false;
}

/*
 * Shells evaluate array subscripts and arithmetic even inside single quotes, so a command substitution
 * hidden in one (`declare 'a[$(…)]=1'`, `x='a[$(…)]'; echo "${b[x]}"`) runs although the literal
 * readings see only `declare` or `echo`. Two things guard this: a line with any such evaluation context
 * is keyed by its exact text (`evaluationContext`), so an allowed `echo` never carries it in; and a line
 * where the hidden form can actually run something is treated as may-publish (`hidesSubstitution`), so
 * edit mode asks. Only the forms that can run — a substitution reached by an evaluation, a run callback
 * (`trap`, `PS4`, `mapfile -C`), `source` from stdin, `find -exec` — count as publishing; evaluation with
 * nothing to run (`for ((i=0;i<${#a[@]};i++))`, `[[ ${#a[@]} -eq 0 ]]`) is only keyed, never published.
 */

/** A command substitution `$( )` (not arithmetic `$(( ))`) or a backtick: it runs when the word expands. */
const SUBST = /\$\((?!\()|`/;
/** Builtins that evaluate an array subscript or arithmetic argument, reached through variables too. */
const EVAL_BUILTINS = new Set(['declare', 'typeset', 'export', 'local', 'readonly', 'read', 'mapfile', 'readarray', 'let', 'unset']);
/** `[[ a -eq b ]]`, `-v name`: both sides are evaluated (unlike `-d`, `-f`, `==`). */
const ARITH_TEST = /(^|\s)-(eq|ne|lt|le|gt|ge|v)(\s|$)/;
/**
 * A parameter expansion that evaluates something: a subscript `${v[…]}`, indirection `${!v}`, `${v@P}`,
 * an arithmetic offset `${v:x}` / `${v:x:y}` (but not a default `${v:-…}` / `${v:+…}` / `${v:=…}`).
 */
const PARAM_EVAL = /\$\{#?!?[A-Za-z_]\w*\[|\$\{!|\$\{[^}]*@[A-Za-z]|\$\{[#!]?[@*\w]+:(?![-=+?}\s])/;
/** An array-element assignment, `a[i]=` / `a[i]+=` / `([i]=…)`: the subscript `i` is evaluated. */
const ARRAY_ASSIGN = /(?:^|[^$\w\]])[A-Za-z_]\w*\[[^\]]*\]\+?=|(?:^|[(\s])\[[^\][]*\]\+?=/;
/** Old-style arithmetic expansion `$[ … ]`. */
const OLD_ARITH = /\$\[/;

/**
 * The line with quoted spans removed: `noSingle` keeps the contents of double quotes (where `$…`
 * expansions still happen) and drops single-quoted spans; `bare` drops both, leaving the unquoted
 * command skeleton (`(( ))`, `[[ ]]`, bare `a[i]=`).
 */
function skeletons(line: string): { noSingle: string; bare: string } {
  let noSingle = '';
  let bare = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (quote === '"') {
      if (ch === '\\' && i + 1 < line.length) noSingle += line[++i];
      else if (ch === '"') quote = null;
      else noSingle += ch;
    } else if (ch === '\\' && i + 1 < line.length) {
      i++; // an unquoted escape: the next character is literal, not structure
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else {
      noSingle += ch;
      bare += ch;
    }
  }
  return { noSingle, bare };
}

/** Whether a `$( )` or backtick sits inside single quotes, where the literal readings leave it as text. */
function hiddenSubstitution(line: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === '`' || (line.startsWith('$(', i) && line[i + 2] !== '(')) return true;
      if (ch === "'") quote = null;
    } else if (quote === '"') {
      if (ch === '\\' && i + 1 < line.length) i++;
      else if (ch === '"') quote = null;
    } else if (ch === '\\' && i + 1 < line.length) {
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return false;
}

/** A `[[ … ]]` test (in the bare skeleton) that evaluates its operands as arithmetic or `-v`. */
function hasArithTest(bare: string): boolean {
  for (let i = bare.indexOf('[['); i >= 0; i = bare.indexOf('[[', i + 2)) {
    const end = bare.indexOf(']]', i + 2);
    if (ARITH_TEST.test(bare.slice(i + 2, end < 0 ? bare.length : end))) return true;
    if (end < 0) break;
  }
  return false;
}

/**
 * The simple commands of both readings for the program-based checks below, skipping a reading that
 * cannot be read (a line the caller already keys exact and asks about on its own).
 */
function bothReadings(line: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  for (const readLine of [parseShellSyntax, parseCommandLine]) {
    try {
      out.push(...readLine(line));
    } catch {
      // Skip this reading; an unreadable line is keyed exact and asked about elsewhere.
    }
  }
  return out;
}

/** A `find … -exec/-execdir/-ok/-okdir CMD … ;` — the command it runs, up to `;` or `+`. */
function findExecCommand(cmd: SimpleCommand): string | undefined {
  if (cmd.args[0] !== 'find') return undefined;
  const at = cmd.args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
  if (at < 0) return undefined;
  const run = cmd.args.slice(at + 1);
  const term = run.findIndex((a) => a === ';' || a === '+');
  return (term < 0 ? run : run.slice(0, term)).join(' ') || undefined;
}

/** The command a run callback carries: `trap 'CMD' …`, `mapfile -C 'CMD' …`; undefined otherwise. */
function callbackCommand(cmd: SimpleCommand): string | undefined {
  if (cmd.args[0] === 'trap') {
    const action = cmd.args.find((a, i) => i > 0 && !a.startsWith('-'));
    return action && action !== '-' ? action : undefined;
  }
  if (cmd.args[0] === 'mapfile' || cmd.args[0] === 'readarray') {
    const at = cmd.args.findIndex((a) => a === '-C' || a.startsWith('-C'));
    if (at >= 0) return cmd.args[at] === '-C' ? cmd.args[at + 1] : cmd.args[at]!.slice(2);
  }
  return undefined;
}

/** A `source` / `.` that reads its script from standard input (`/dev/stdin`, `/dev/fd/0`, `-`). */
function sourcesStdin(cmd: SimpleCommand): boolean {
  if (cmd.args[0] !== 'source' && cmd.args[0] !== '.') return false;
  return cmd.args.slice(1).some((a) => a === '-' || /\/dev\/(stdin|fd\/)/.test(a));
}

/** `source` / `.` with a script given on the command line (a path), not read from stdin. */
function sourcesFile(cmd: SimpleCommand): boolean {
  return (cmd.args[0] === 'source' || cmd.args[0] === '.') && cmd.args.length > 1;
}

/** `declare`/`local`/`typeset -i|-n` (integer or nameref): the value is evaluated when assigned. */
function typedDeclaration(cmd: SimpleCommand): boolean {
  if (!EVAL_BUILTINS.has(cmd.args[0]!)) return false;
  return cmd.args.some((a) => /^-[a-zA-Z]*[in]/.test(a));
}

/** The target of `printf -v NAME …` (`-v name`, `-vname`, `-v'a[$(…)]'`), or undefined if it has none. */
function printfTarget(cmd: SimpleCommand): string | undefined {
  if (cmd.args[0] !== 'printf') return undefined;
  for (let i = 1; i < cmd.args.length; i++) {
    const a = cmd.args[i]!;
    if (a === '-v') return cmd.args[i + 1];
    if (a.startsWith('-v')) return a.slice(2);
    if (!a.startsWith('-')) return undefined; // the format reached, no `-v`
  }
  return undefined;
}

/** A `printf -v` whose target names an array element or holds a variable the subscript is built from. */
function printfEvaluates(cmd: SimpleCommand): boolean {
  const t = printfTarget(cmd);
  return t !== undefined && (t.includes('[') || t.includes('$'));
}

/** An evaluation builtin given an argument that holds (or expands to) a subscript or substitution. */
function builtinEvaluates(cmd: SimpleCommand): boolean {
  const [program, ...rest] = cmd.args;
  if (program === 'printf') return printfEvaluates(cmd);
  if (!program || !EVAL_BUILTINS.has(program)) return false;
  return rest.some((a) => a.includes('[') || a.includes('$'));
}

/**
 * Whether a command line holds any context where the shell evaluates a subscript or arithmetic: a line
 * with one is keyed by its exact text only, so an allowed single program (`echo`, `declare`) never
 * carries an evaluation in. Broader than publishing; it never makes a line ask more often.
 */
export function evaluationContext(line: string): boolean {
  const { noSingle, bare } = skeletons(line);
  if (PARAM_EVAL.test(noSingle) || OLD_ARITH.test(noSingle) || /\$\(\(/.test(noSingle)) return true;
  if (/\(\(/.test(bare) || ARRAY_ASSIGN.test(bare) || hasArithTest(bare)) return true;
  if (/(^|[\s;&|(])PS4=/.test(line)) return true;
  return bothReadings(line).some(
    (c) =>
      c.args[0] === 'let' ||
      typedDeclaration(c) ||
      sourcesFile(c) ||
      sourcesStdin(c) ||
      findExecCommand(c) !== undefined ||
      callbackCommand(c) !== undefined ||
      printfEvaluates(c) ||
      (EVAL_BUILTINS.has(c.args[0]!) && c.args.slice(1).some((a) => a.includes('['))),
  );
}

/**
 * Whether a command line can run a command the literal readings do not see: a substitution hidden in a
 * single-quoted subscript or arithmetic that an evaluation reaches (`declare 'a[$(…)]=1'`,
 * `x='a[$(…)]'; echo "${b[x]}"`, `y='[$(…)]'; declare "a$y=1"`), a run callback (`trap`, `PS4`,
 * `mapfile -C`), `source` from stdin, or `find -exec`. Treated as may-publish, since what it runs is
 * unknown. Pure evaluation with no substitution (`[[ ${#a[@]} -eq 0 ]]`) is not counted.
 */
export function hidesSubstitution(line: string): boolean {
  const { noSingle, bare } = skeletons(line);
  if (hiddenSubstitution(line)) {
    // A subscript or arithmetic that reaches it, in the text or through a builtin/variable.
    if (PARAM_EVAL.test(noSingle) || OLD_ARITH.test(noSingle) || ARRAY_ASSIGN.test(bare)) return true;
    if (/\(\([^)]*[A-Za-z_]/.test(bare) || /\$\(\([^)]*[A-Za-z_]/.test(noSingle)) return true;
    if (hasArithTest(bare) || /(^|[\s;&|(])PS4=/.test(line)) return true;
    if (bothReadings(line).some((c) => builtinEvaluates(c) || c.args[0] === 'let')) return true;
  }
  for (const c of bothReadings(line)) {
    if (sourcesStdin(c)) return true;
    const inner = findExecCommand(c) ?? callbackCommand(c);
    if (inner !== undefined && inner !== line && isPublishCommand(inner)) return true;
  }
  return false;
}

/**
 * Whether a command line pushes or publishes (git push, npm publish, gh release…). Best effort: a
 * script or a program can still push on its own.
 */
export function isPublishCommand(line: string): boolean {
  if (LEGACY_PUBLISH.test(line)) return true;
  if (hidesSubstitution(line)) return true; // a push hidden where the shell still runs it
  // Either reading finding a push is enough.
  return [parseShellSyntax, parseCommandLine].some((readLine) => {
    try {
      return readLine(line).some(publishes);
    } catch {
      return true; // too convoluted to read: ask
    }
  });
}

/** The first version's check, kept as a floor: whatever it caught is still caught. */
const LEGACY_PUBLISH = /(^|[;&|(]\s*)(git\s+push|(npm|pnpm|yarn|bun|cargo|poetry|gem)\s+publish|twine\s+upload)\b/;

/** An argument as the shell reads it back: as it is when nothing in it is special, else single-quoted. */
function shellArgument(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A tool call's command as one shell line: a string as it is, an argument list with each argument
 * quoted where the shell would split it, so `["bash", "-lc", "git push origin main"]` reads as the
 * push it runs (`bash -lc 'git push origin main'`), never as `bash -lc git` with stray words.
 * Undefined for anything else, or an empty command.
 */
export function commandLine(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() ? v : undefined;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.map(shellArgument).join(' ');
  return undefined;
}
