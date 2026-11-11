// A problem report (the sidebar's button beside Settings), sent by email: the dialog's text, made
// into a mail the user's own mail app (a mailto link) or Gmail opens, filled in, for them to send.
// Nothing goes out until they do. Pure, so it can be tested without a DOM.

import {
  PROVIDERS,
  PROVIDER_LABEL,
  REPORT_SCREENSHOT_EXTENSIONS,
  REPORT_SCREENSHOT_LIMITS,
  REPORT_SCREENSHOT_TYPES,
  type AboutInfo,
  type ProviderStatus,
  type ReportScreenshots,
} from '../shared/types';
import type { Messages } from './i18n';

/** Where problem reports go. */
export const REPORT_EMAIL = 'chihyu.jimmy.yeh@gmail.com';

export const REPORT_KINDS = ['bug', 'idea', 'other'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ReportDraft {
  kind: ReportKind;
  /** May be empty: the description's first line stands in. */
  subject: string;
  description: string;
}

export const EMPTY_REPORT: ReportDraft = { kind: 'bug', subject: '', description: '' };

export const REPORT_SUBJECT_MAX = 120;
export const REPORT_DESCRIPTION_MAX = 20_000;

/**
 * The longest mailto link handed to the mail app. Every mail app takes 2,000 characters; some cut a
 * longer one short without a word. A report that does not fit goes by the clipboard instead.
 */
export const MAILTO_MAX = 2_000;
/** The longest Gmail link (its address takes much more; this stays well clear of what Google refuses). */
export const GMAIL_MAX = 8_000;

/**
 * How a report went out: through the mail app or Gmail, put on the clipboard for a mail link too short
 * for it (`cut`) or by Copy report (`copied`); or not, the clipboard refusing it (`cutCopyFailed`).
 */
export type Sent = 'mail' | 'gmail' | 'cut' | 'cutCopyFailed' | 'copied';

/**
 * Whether the report counts as sent: its upload is the one the mail links to (kept on GitHub), and it is
 * forgotten when the dialog closes. Not when the clipboard refused it: the mail holds no report then.
 */
export function countsAsSent(sent: Sent | undefined): boolean {
  return sent !== undefined && sent !== 'cutCopyFailed';
}

/** Only the description is needed: there is nothing to report without it. */
export function reportReady(d: ReportDraft): boolean {
  return d.description.trim().length > 0;
}

/**
 * What the dialog lets the user do: change the screenshots only until they are uploaded (Remove upload
 * lets them change again), nothing while an upload or a removal goes on; and send once there is a
 * description, the details that go along are known (`aboutKnown`: loaded, or known to be missing), and
 * the screenshots added are uploaded (`waiting` until then: the mail would say nothing of them).
 */
export function reportState(o: { draft: ReportDraft; shots: number; uploaded: boolean; busy: boolean; aboutKnown: boolean }): {
  editable: boolean;
  waiting: boolean;
  ready: boolean;
} {
  const waiting = o.shots > 0 && !o.uploaded;
  return {
    editable: !o.uploaded && !o.busy,
    waiting,
    ready: reportReady(o.draft) && !waiting && !o.busy && o.aboutKnown,
  };
}

/**
 * What goes along with a report, a line each: this Harness Relay's version and how it runs, the
 * computer's system, the browser, each CLI's version and the UI's language. Nothing that names the
 * user, their accounts or their files. `about`: undefined while it loads (left out), null when the
 * server could not say (said so).
 */
export function infoLines(o: { about?: AboutInfo | null; providers: ProviderStatus[]; userAgent: string; lang: string }, t: Messages): string[] {
  const { info: i, line } = t.report;
  const lines: string[] = [];
  if (o.about) {
    lines.push(line('Harness Relay', `${o.about.version} · ${o.about.desktop ? i.desktop : i.web}`));
    lines.push(line(i.os, o.about.os));
    lines.push(line('Node.js', o.about.node));
  } else if (o.about === null) {
    lines.push(line('Harness Relay', i.unknown));
  }
  if (o.userAgent) lines.push(line(i.browser, o.userAgent));
  for (const p of PROVIDERS) {
    const s = o.providers.find((x) => x.provider === p);
    if (s) lines.push(line(PROVIDER_LABEL[p], s.installed ? s.version?.trim() || i.installed : i.notInstalled));
  }
  lines.push(line(i.language, o.lang));
  return lines;
}

/** `max` characters of `text` at most (whole characters, not UTF-16 halves), an ellipsis marking a cut. */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** The mail's subject: its kind, and the subject typed (or the description's first line). */
export function reportSubject(d: ReportDraft, t: Messages): string {
  const typed = d.subject.replace(/\s+/g, ' ').trim();
  const firstLine = d.description.trim().split('\n')[0]!.trim();
  return t.report.subjectLine(t.report.kinds[d.kind], typed || clip(firstLine, 60));
}

/**
 * The mail's text: the description, then its kind and `info` (always, shown in the dialog), then the
 * link to the screenshots uploaded (`screenshots`, their gist's page), or else where screenshots go.
 */
export function reportBody(d: ReportDraft, info: string[], t: Messages, screenshots?: string): string {
  const m = t.report.mail;
  const last = screenshots ? t.report.line(m.screenshotsLink, screenshots) : m.screenshots;
  return [d.description.trim(), '', '---', t.report.line(m.kind, t.report.kinds[d.kind]), ...info, '', last].join('\n');
}

/**
 * Why an image cannot be added to the report's screenshots, `count` being there already: one too many,
 * not a PNG, JPEG or WebP image (by its type, and its name when it has one with an ending: a JPEG saved
 * as .jfif is not taken; the server checks its bytes), or too large.
 */
export function screenshotProblem(file: { type: string; size: number; name?: string }, count: number): 'tooMany' | 'notImage' | 'tooLarge' | undefined {
  if (count >= REPORT_SCREENSHOT_LIMITS.maxFiles) return 'tooMany';
  if (!REPORT_SCREENSHOT_TYPES.includes(file.type)) return 'notImage';
  const ending = /\.[^./\\]+$/.exec(file.name ?? '')?.[0]?.toLowerCase();
  if (ending && !REPORT_SCREENSHOT_EXTENSIONS.includes(ending)) return 'notImage';
  if (file.size > REPORT_SCREENSHOT_LIMITS.maxBytes) return 'tooLarge';
  return undefined;
}

/** The whole mail as text, to paste into any mail: where it goes, its subject and its text. */
export function reportText(to: string, subject: string, body: string, t: Messages): string {
  const { line, mail } = t.report;
  return `${line(mail.to, to)}\n${line(mail.subject, subject)}\n\n${body}`;
}

/** Line breaks as RFC 6068 has them in a mailto link (CRLF), the rest percent-encoded. */
const mailtoPart = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, '\r\n'));

export function mailtoUrl(to: string, subject: string, body: string): string {
  return `mailto:${to}?subject=${mailtoPart(subject)}&body=${mailtoPart(body)}`;
}

/** Gmail's page for writing a mail, filled in. */
export function gmailUrl(to: string, subject: string, body: string): string {
  const q = (s: string) => encodeURIComponent(s);
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${q(to)}&su=${q(subject)}&body=${q(body)}`;
}

export interface MailLink {
  url: string;
  /** The report did not fit: the mail only says to paste it (from the clipboard). */
  cut: boolean;
}

/**
 * The link `make` makes of the mail, when it is `max` characters at most. A longer one carries
 * `pasteHere` for its text instead (and, should even that be too long, its subject shortened).
 */
export function fitLink(make: (subject: string, body: string) => string, subject: string, body: string, pasteHere: string, max: number): MailLink {
  const url = make(subject, body);
  if (url.length <= max) return { url, cut: false };
  const chars = [...subject];
  for (let n = chars.length; n > 0; n--) {
    const short = make(n === chars.length ? subject : `${chars.slice(0, n).join('')}…`, pasteHere);
    if (short.length <= max) return { url: short, cut: true };
  }
  return { url: make('', pasteHere), cut: true };
}

/** What a report's screenshots need of the server (api.ts; fakes in tests). */
export interface ShotsApi {
  upload(images: string[]): Promise<ReportScreenshots>;
  remove(id: string): Promise<unknown>;
  /** Whether a removal failed because the server no longer knows the upload (it restarted): forgotten here too. */
  gone(err: unknown): boolean;
}

/**
 * A report's screenshots on GitHub: the upload under way or done, and its removal. Kept apart from the
 * dialog, which may close while either goes on: opened again, it shows how they went, instead of
 * offering to upload the screenshots again or showing an upload that was removed.
 */
export class ShotUploads {
  /** The upload done: its gist. */
  done?: ReportScreenshots;
  private going?: Promise<ReportScreenshots>;
  private removing?: Promise<void>;
  /** The gist being deleted, so that forgetting the report meanwhile does not delete it twice. */
  private removingId?: string;
  /** Counts the reports forgotten: what goes on for one forgotten no longer counts. */
  private report = 0;
  /** The upload the sent mail links to (`sent`): it stays on GitHub once the report is forgotten. */
  private linked?: string;
  private listeners = new Set<() => void>();

  constructor(private api: ShotsApi) {}

  /** What goes on: an upload, or a removal. */
  get busy(): 'upload' | 'remove' | undefined {
    return this.going ? 'upload' : this.removing ? 'remove' : undefined;
  }

  /** The upload under way, for a dialog opened meanwhile to say how it went. */
  get pending(): Promise<ReportScreenshots> | undefined {
    return this.going;
  }

  /** Told each time something changes; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    this.listeners.forEach((fn) => fn());
  }

  /**
   * Uploads the screenshots `images` gives (base64): the upload under way when there is one, the one
   * done when it is. One that ends after its report was forgotten (sent) belongs to no report: its gist
   * is deleted again, and the next report knows nothing of it.
   */
  upload(images: () => Promise<string[]>): Promise<ReportScreenshots> {
    if (this.done) return Promise.resolve(this.done);
    if (!this.going) {
      const report = this.report;
      let going: Promise<ReportScreenshots> | undefined = undefined;
      going = (async () => {
        try {
          const done = await this.api.upload(await images());
          if (report === this.report) this.done = done;
          else void Promise.resolve(this.api.remove(done.id)).catch(() => undefined);
          return done;
        } finally {
          if (this.going === going) this.going = undefined;
          this.changed();
        }
      })();
      this.going = going;
      this.changed();
    }
    return this.going;
  }

  /** Deletes the upload's gist, and forgets it once it is gone (also when the server no longer knows it). */
  remove(): Promise<void> {
    const done = this.done;
    if (!done) return Promise.resolve();
    if (!this.removing) {
      const report = this.report;
      this.removingId = done.id;
      let removing: Promise<void> | undefined = undefined;
      removing = (async () => {
        try {
          await this.api.remove(done.id);
          if (report === this.report) this.done = undefined;
        } catch (err) {
          if (report === this.report && this.api.gone(err)) this.done = undefined;
          throw err;
        } finally {
          if (this.removing === removing) this.removing = undefined;
          if (this.removingId === done.id) this.removingId = undefined;
          this.changed();
        }
      })();
      this.removing = removing;
      this.changed();
    }
    return this.removing;
  }

  /** The mail was sent: it links to the upload done now, if any, which then stays on GitHub. */
  sent(): void {
    this.linked = this.done?.id;
  }

  /**
   * Forgets the report's upload, and what goes on: the report was sent. An upload no sent mail links to
   * (made after the mail went) belongs to nothing: its gist is deleted again, as one ending later is.
   */
  forget(): void {
    const done = this.done;
    if (done && done.id !== this.linked && done.id !== this.removingId) void Promise.resolve(this.api.remove(done.id)).catch(() => undefined);
    this.linked = undefined;
    this.report++;
    this.done = undefined;
    this.going = undefined;
    this.removing = undefined;
    this.changed();
  }
}
