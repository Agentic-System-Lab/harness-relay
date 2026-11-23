import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { CliLoginView, LoginState } from '../shared/types';
import { CommandNotFoundError, killTree, spawnInteractive, stripAnsi } from './process';

/** How long a sign-in may wait for the user (a device code lasts about as long). */
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const URL_RE = /https?:\/\/[^\s"'<>\u001b]+/g;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g;

/**
 * A CLI's own sign-in, run as it is in a terminal but without one: what it prints, with the links and
 * the codes in it for the UI to show, and what is pasted to it. A device sign-in (a link and a code
 * to approve there) ends when the CLI exits: 0 is signed in, unless its output says otherwise
 * (`failsWith`). It is cancelled after `LOGIN_TIMEOUT_MS`. The CLIs' sign-ins in Settings
 * (`ProviderService`) and gh's for sharing (`GhLogin`) are these.
 */
export class CliLogin {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  private child: ChildProcess;
  private output = '';
  private state: LoginState = 'running';
  private exitCode: number | null | undefined;
  private timer: NodeJS.Timeout;

  constructor(
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    /** What in its output means the sign-in failed, whatever its exit code. */
    private failsWith: RegExp | undefined,
    private onDone: () => void,
  ) {
    this.child = spawnInteractive(bin, args, env);
    const onData = (chunk: Buffer) => {
      this.output += chunk.toString('utf8');
      if (this.output.length > 32_000) this.output = this.output.slice(-32_000);
    };
    this.child.stdout!.on('data', onData);
    this.child.stderr!.on('data', onData);
    this.child.stdin!.on('error', () => {});
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.output += `\n${err.code === 'ENOENT' ? new CommandNotFoundError(bin).message : err.message}\n`;
      this.finish('failed', null);
    });
    this.child.on('close', (code) => {
      const failed = code !== 0 || Boolean(this.failsWith?.test(stripAnsi(this.output)));
      if (this.state === 'running') this.finish(failed ? 'failed' : 'success', code);
    });
    this.timer = setTimeout(() => this.cancel(), LOGIN_TIMEOUT_MS);
  }

  private finish(state: LoginState, code: number | null): void {
    this.state = state;
    this.exitCode = code;
    clearTimeout(this.timer);
    this.onDone();
  }

  write(text: string): void {
    if (this.state !== 'running' || !this.child.stdin?.writable) return;
    this.child.stdin.write(text.trim() + '\n');
  }

  cancel(): void {
    if (this.state !== 'running') return;
    this.finish('cancelled', null);
    killTree(this.child, 'SIGTERM');
    setTimeout(() => killTree(this.child, 'SIGKILL'), 2000);
  }

  view(): CliLoginView {
    const clean = stripAnsi(this.output).replace(/\r/g, '');
    const urls = [...new Set(clean.match(URL_RE) ?? [])];
    const codes = [...new Set(clean.match(CODE_RE) ?? [])];
    const lastLine = clean.trimEnd().split('\n').pop() ?? '';
    return {
      id: this.id,
      state: this.state,
      startedAt: this.startedAt,
      output: clean,
      urls,
      codes,
      wantsInput: this.state === 'running' && /(paste|enter).*code|code.*>\s*$/i.test(lastLine),
      exitCode: this.exitCode,
    };
  }
}
