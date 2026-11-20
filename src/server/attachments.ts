import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { ChatMessage, MessagePart } from '../shared/types';
import { ATTACHMENT_LIMITS, isInlineImage } from '../shared/types';
import { HttpError } from './errors';
import { t } from './i18n';
import { DATA_DIR } from './settings';

/** A file the user attached, as the browser sends it. */
export interface AttachmentUpload {
  name?: unknown;
  mimeType?: unknown;
  /** Base64 contents. */
  data?: unknown;
}

export type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;

/** Files of one conversation: data/attachments/<conversation>/<attachment id>/<file name>. */
export function attachmentsDir(convId: string): string {
  return join(DATA_DIR, 'attachments', convId);
}

/** A file name that is safe to put on disk (no directories, no control characters). */
export function safeFileName(name: string): string {
  const clean = basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return clean || 'file';
}

export function attachmentPath(convId: string, a: Pick<AttachmentPart, 'id' | 'name'>): string {
  return join(attachmentsDir(convId), a.id, safeFileName(a.name));
}

export interface AttachmentData {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Validate the whole upload before writing any file. */
export function decodeAttachments(uploads: unknown): AttachmentData[] {
  if (uploads === undefined) return [];
  if (!Array.isArray(uploads)) throw new HttpError(400, t().badAttachment);
  if (uploads.length > ATTACHMENT_LIMITS.maxFiles) throw new HttpError(400, t().tooManyAttachments(ATTACHMENT_LIMITS.maxFiles));
  return uploads.map((u) => {
    if (typeof u?.data !== 'string' || typeof u.name !== 'string') throw new HttpError(400, t().badAttachment);
    const bytes = Buffer.from(u.data, 'base64');
    const name = safeFileName(u.name);
    if (bytes.length > ATTACHMENT_LIMITS.maxBytes) throw new HttpError(400, t().attachmentTooLarge(name, ATTACHMENT_LIMITS.maxBytes));
    const mimeType = typeof u.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(u.mimeType) ? u.mimeType : 'application/octet-stream';
    return { name, mimeType, bytes };
  });
}

/** Give each message its own files, including when several runs use the same automation. */
export function writeAttachments(convId: string, files: Iterable<AttachmentData>): AttachmentPart[] {
  const parts: AttachmentPart[] = [];
  try {
    for (const f of files) {
      const part: AttachmentPart = { type: 'attachment', id: randomUUID(), name: f.name, mimeType: f.mimeType, size: f.bytes.length };
      parts.push(part);
      mkdirSync(join(attachmentsDir(convId), part.id), { recursive: true });
      writeFileSync(attachmentPath(convId, part), f.bytes, { mode: 0o600 });
    }
    return parts;
  } catch (err) {
    removeAttachments(convId, parts);
    throw err;
  }
}

export function saveAttachments(convId: string, uploads: AttachmentUpload[] | undefined): AttachmentPart[] {
  return writeAttachments(convId, decodeAttachments(uploads));
}

/**
 * Copy attached files of one conversation to another (a branch of it): a copy-on-write clone where the
 * filesystem can make one. A file that is gone is skipped: its link answers "not found", as it did there.
 */
export async function copyAttachments(fromConvId: string, toConvId: string, parts: AttachmentPart[]): Promise<void> {
  for (const p of parts) {
    await mkdir(join(attachmentsDir(toConvId), p.id), { recursive: true });
    const to = attachmentPath(toConvId, p);
    try {
      await copyFile(attachmentPath(fromConvId, p), to, constants.COPYFILE_FICLONE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    await chmod(to, 0o600);
  }
}

/**
 * The files of one conversation's folder its copied replies show by their path there (the browser's
 * screenshots, `browser-<time>.png`, which no attachment part names), copied to the branch's folder; the
 * copied replies' text then names the branch's folder, where its attached files are too
 * (`copyAttachments`), so the branch shows them as the conversation did, and keeps them if that one is
 * deleted.
 */
export async function copyShownFiles(fromConvId: string, toConvId: string, messages: ChatMessage[]): Promise<void> {
  const from = attachmentsDir(fromConvId) + sep;
  const to = attachmentsDir(toConvId) + sep;
  const texts = messages.flatMap((m) => m.parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'));
  const names = new Set<string>();
  for (const p of texts) {
    for (let i = p.text.indexOf(from); i >= 0; i = p.text.indexOf(from, i + from.length)) {
      const name = /^browser-[A-Za-z0-9-]+\.png/.exec(p.text.slice(i + from.length))?.[0];
      if (name) names.add(name);
    }
  }
  if (names.size) await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of names) {
    try {
      await copyFile(from + name, to + name, constants.COPYFILE_FICLONE);
      await chmod(to + name, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  for (const p of texts) if (p.text.includes(from)) p.text = p.text.split(from).join(to);
}

export function removeAttachments(convId: string, parts?: AttachmentPart[]): void {
  if (!parts) {
    rmSync(attachmentsDir(convId), { recursive: true, force: true });
    return;
  }
  for (const p of parts) rmSync(join(attachmentsDir(convId), p.id), { recursive: true, force: true });
}

/** Images an agent can be shown directly (in the formats every CLI accepts). */
export function imageInputs(convId: string, parts: AttachmentPart[]): { path: string; mimeType: string }[] {
  return parts.filter((p) => isInlineImage(p.mimeType)).map((p) => ({ path: attachmentPath(convId, p), mimeType: p.mimeType }));
}

export { isInlineImage };
