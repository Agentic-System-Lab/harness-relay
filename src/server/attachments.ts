import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MessagePart } from '../shared/types';
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

/** Writes the uploaded files to disk and returns their message parts. Throws a 400 for bad input. */
export function saveAttachments(convId: string, uploads: AttachmentUpload[] | undefined): AttachmentPart[] {
  if (!uploads?.length) return [];
  if (!Array.isArray(uploads)) throw new HttpError(400, t().badAttachment);
  if (uploads.length > ATTACHMENT_LIMITS.maxFiles) throw new HttpError(400, t().tooManyAttachments(ATTACHMENT_LIMITS.maxFiles));
  const files = uploads.map((u) => {
    if (typeof u?.data !== 'string' || typeof u.name !== 'string') throw new HttpError(400, t().badAttachment);
    const bytes = Buffer.from(u.data, 'base64');
    const name = safeFileName(u.name);
    if (bytes.length > ATTACHMENT_LIMITS.maxBytes) throw new HttpError(400, t().attachmentTooLarge(name, ATTACHMENT_LIMITS.maxBytes));
    const mimeType = typeof u.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(u.mimeType) ? u.mimeType : 'application/octet-stream';
    return { name, mimeType, bytes };
  });
  return files.map((f) => {
    const part: AttachmentPart = { type: 'attachment', id: randomUUID(), name: f.name, mimeType: f.mimeType, size: f.bytes.length };
    const file = attachmentPath(convId, part);
    mkdirSync(join(attachmentsDir(convId), part.id), { recursive: true });
    writeFileSync(file, f.bytes, { mode: 0o600 });
    return part;
  });
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
