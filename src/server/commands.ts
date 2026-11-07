/*
 * What a shell command line runs: the programs and their arguments, for "always allow" rule keys and
 * for spotting commands that push or publish. Best effort, not a shell parser. It handles the forms
 * CLIs and models commonly use: chains, pipes, background jobs, `$( )` / backtick substitutions,
 * `sh -c '…'`, heredocs, redirections, line continuations, `VAR=value` assignments, wrappers such as
 * `env` or `timeout`, paths to programs, and git's global options. When unsure it errs toward keys
 * that match less (so approvals ask more), never more.
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

/**
 * Split a command line into the text of its simple commands. Separators (`;`, `|`, `&`, newlines,
 * `( )`, `{ }`) count outside quotes only; `>&` / `&>` are redirections, not separators. Command
 * substitutions run commands of their own (also inside double quotes), so their content is split out
 * as well and the substitution is left as a DYNAMIC placeholder. Heredoc bodies are skipped.
 * With `inSubst`, scanning stops at the `)` closing the substitution; returns the index reached.
 */
function scan(line: string, start: number, inSubst: boolean, parts: string[], depth = 0): number {
  if (depth > MAX_DEPTH) throw new Error('command nesting too deep');
  let cur = '';
  let quote: '"' | "'" | null = null;
  let groups = 0; // plain `( )` groups inside a substitution
  const heredocs: { word: string; strip: boolean }[] = [];
  const end = () => {
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
      scan(inner, 0, false, parts, depth + 1);
      cur += DYNAMIC;
      i = j;
    } else if (ch === '$' && line[i + 1] === '(') {
      i = scan(line, i + 2, true, parts, depth + 1);
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
        heredocs.push({ word: m[2]!.replace(/['"\\]/g, ''), strip: m[1] === '-' });
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
      for (const h of heredocs) {
        found = false;
        while (j < line.length) {
          const nl = line.indexOf('\n', j);
          const text = line.slice(j, nl < 0 ? line.length : nl).replace(/\r$/, '');
          j = nl < 0 ? line.length : nl + 1;
          if ((h.strip ? text.replace(/^\t+/, '') : text) === h.word) {
            found = true;
            break;
          }
        }
        if (!found) break;
      }
      heredocs.length = 0;
      if (found) i = j - 1;
    } else if (inSubst && ch === ')' && groups === 0) {
      end();
      return i;
    } else if (';|&\n(){}'.includes(ch)) {
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

/**
 * Words of a simple command, with quotes and escapes removed and redirections (`>out`, `2>&1`,
 * `< in`) dropped: `git commit -m "a b" >log` → git, commit, -m, a b.
 */
function words(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false;
  let skipTarget = false; // the next word is a redirection's target
  const push = () => {
    if (cur || started) {
      if (skipTarget) skipTarget = false;
      else out.push(cur);
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
      if (/^\d+$/.test(cur) || cur === '&') cur = ''; // a file descriptor: `2>`, `&>`
      push();
      while (i + 1 < segment.length && /[<>&|]/.test(segment[i + 1]!)) i++;
      // `>&1` / `>&-` duplicate a descriptor: no file name follows.
      const dup = /^\d+|^-/.exec(segment.slice(i + 1));
      if (segment[i] === '&' && dup) i += dup[0].length;
      else skipTarget = true;
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
}

/**
 * The program and its arguments for one simple command. `VAR=value` assignments and wrapper programs
 * (`env`, `timeout 10`…) are skipped and the program is given without its path. A wrapper that leaves
 * nothing behind (`sudo -s`) is itself the program; `env -S '…'` runs its string as a command line.
 */
function command(segmentWords: string[], text: string, nested: string[]): SimpleCommand | undefined {
  const w = [...segmentWords];
  const privileged: string[] = [];
  const assignments: string[] = [];
  for (;;) {
    while (w.length && isAssignment(w[0]!)) assignments.push(w.shift()!);
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
    if (split !== undefined) nested.push(split);
    if (k >= rest.length) break; // nothing left to run: the wrapper is the command
    if (PRIVILEGED[program]) privileged.push(program);
    w.splice(0, k + 1);
  }
  if (!w.length) return undefined;
  const dynamic = w[0]!.includes(DYNAMIC) || w[0]!.startsWith('$');
  w[0] = basename(w[0]!);
  return { args: w.map((x) => x.replaceAll(DYNAMIC, '')), privileged, dynamic, assignments, text: text.trim() };
}

/** Every simple command in a command line; `sh -c '…'` and `env -S '…'` are read recursively. */
export function parseCommandLine(line: string, depth = 0): SimpleCommand[] {
  const parts: string[] = [];
  scan(line, 0, false, parts);
  const out: SimpleCommand[] = [];
  for (const part of parts) {
    const nested: string[] = [];
    const cmd = command(words(part), part.includes(DYNAMIC) ? line : part, nested);
    for (const n of nested) if (depth < 3) out.push(...parseCommandLine(n, depth + 1));
    if (!cmd) continue;
    // `sh -c 'script'`: options before the first other word; `bash ./script.sh -c x` runs a script.
    let c = -1;
    if (SHELLS.has(cmd.args[0]!)) {
      for (let i = 1; i < cmd.args.length && cmd.args[i]!.startsWith('-'); i++) {
        if (/^-[a-z]*c[a-z]*$/i.test(cmd.args[i]!)) c = i;
      }
    }
    const inner = c > 0 && cmd.args[c + 1] !== undefined && depth < 3 && !cmd.privileged.length ? parseCommandLine(cmd.args[c + 1]!, depth + 1) : [];
    // A `-c` script with no command in it (`sh -c '{}'` under xargs) is still the shell running something.
    out.push(...(inner.length ? inner : [cmd]));
  }
  return out;
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
  if (cmd.dynamic) return cmd.text;
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

/**
 * Whether a command line pushes or publishes (git push, npm publish, gh release…). Best effort: a
 * script or a program can still push on its own.
 */
export function isPublishCommand(line: string): boolean {
  if (LEGACY_PUBLISH.test(line)) return true;
  try {
    return parseCommandLine(line).some(publishes);
  } catch {
    return true; // too convoluted to read: ask
  }
}

/** The first version's check, kept as a floor: whatever it caught is still caught. */
const LEGACY_PUBLISH = /(^|[;&|(]\s*)(git\s+push|(npm|pnpm|yarn|bun|cargo|poetry|gem)\s+publish|twine\s+upload)\b/;
