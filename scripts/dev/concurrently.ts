/*
 * How `npm run dev` (scripts/dev.ts) runs the server and Vite: concurrently's own command line, with
 * the same command as before, and the signals this process gets passed on to it.
 */
import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** What concurrently runs, as `npm run dev` always ran it. */
export const DEV_COMMAND: readonly string[] = [
  '-k',
  '-n',
  'server,web',
  '-c',
  'blue,magenta',
  'tsx watch --clear-screen=false src/server/index.ts',
  'vite',
];

/** The signals passed on to concurrently. */
export const DEV_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** concurrently's own command line (its package's `bin`), run with this Node. */
export function concurrentlyBin(): string {
  const manifest = createRequire(import.meta.url).resolve('concurrently/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> };
  return join(dirname(manifest), bin.concurrently);
}

/**
 * Passes the signals this process gets on to concurrently, which stops its commands for each (they
 * share this process group, or its console on Windows, so a terminal's Ctrl+C reaches them too, and
 * concurrently sends them one again as it always did). One sent to this process alone (npm passing
 * one on) would otherwise never reach it. Never on Windows, where kill() ends a process at once,
 * before it stops its commands: there every process on the console gets Ctrl+C.
 */
export function passSignals(
  child: Pick<ChildProcess, 'kill'>,
  from: EventEmitter = process,
  platform: NodeJS.Platform = process.platform,
): void {
  for (const signal of DEV_SIGNALS) {
    from.on(signal, () => {
      if (platform !== 'win32') child.kill(signal);
    });
  }
}
