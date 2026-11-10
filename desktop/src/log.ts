/**
 * The server's log (its output, shown by "Show log"): a file that starts over, the previous one kept
 * as `.old`, once it grows past its limit, at a start and also while the server runs (a server can
 * run for weeks). Written synchronously, a chunk of output at a time (there is little of it), so that
 * starting over never races a file still being opened. A log that cannot be written (a full disk, a
 * folder the app may not write in) is given up on quietly: never an uncaught error in the app.
 */
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOG_LIMIT = 5 * 1024 * 1024;

export class ServerLog {
  private fd?: number;
  private size = 0;

  constructor(
    readonly file: string,
    private limit = LOG_LIMIT,
  ) {}

  /** Starts a section (a start of the server) with `header`, starting over first when the file is too big. */
  open(header: string): void {
    this.close();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      try {
        this.size = statSync(this.file).size;
      } catch {
        this.size = 0; // no log yet
      }
      if (this.size > this.limit) this.rotate();
      else this.fd = openSync(this.file, 'a');
    } catch {
      this.fd = undefined;
    }
    this.write(header);
  }

  write(chunk: string): void {
    if (this.fd === undefined) return;
    const bytes = Buffer.from(chunk);
    try {
      if (this.size > 0 && this.size + bytes.length > this.limit) this.rotate();
      if (this.fd === undefined) return;
      writeSync(this.fd, bytes);
      this.size += bytes.length;
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      /* closed already */
    }
    this.fd = undefined;
  }

  private rotate(): void {
    this.close();
    try {
      renameSync(this.file, `${this.file}.old`);
    } catch {
      /* kept growing in the same file */
    }
    this.size = 0;
    this.fd = openSync(this.file, 'a');
  }
}
