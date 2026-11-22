// The Files panel's editing and uploading, without the DOM: what can be edited, what a text box holds,
// and what a pick or drop of files sends (paths relative to the browsed folder, with `/`).

import { fileNameProblem, type FileNameProblem } from '../shared/fileNames';
import { FILE_EDIT_LIMITS, type FileEntry, type FileListing, type FilePreview } from '../shared/types';

/** Whether the panel offers to edit this file: a root it may write in, and a whole text file the server gave a version. */
export function canEdit(listing: Pick<FileListing, 'writable'> | null, preview: FilePreview | null): boolean {
  return Boolean(listing?.writable && preview?.kind === 'text' && preview.version);
}

/**
 * Text as a browser's text box holds it: every line break as LF (it gives CRLF and CR so). The server
 * puts a file's CRLF back when it saves (`keepTextFormat` in src/server/fileEdit.ts).
 */
export function editorText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Whether what the text box holds differs from the file as it was loaded. */
export function isDirty(original: string, edited: string): boolean {
  return editorText(original) !== editorText(edited);
}

/** Ctrl+S, or ⌘S on a Mac: save while editing (not the browser's Save Page). */
export function isSaveKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

/** A file picked or dropped, as the plan needs it (`folder`: a dropped folder, which cannot go up as such). */
export interface PickedFile {
  name: string;
  size: number;
  folder?: boolean;
}

/** Why a picked file is not sent. */
export type UploadRefusal =
  | { name: string; why: 'name'; problem: FileNameProblem }
  | { name: string; why: 'size' }
  | { name: string; why: 'folder' }
  | { name: string; why: 'tooMany' }
  | { name: string; why: 'duplicate' }
  | { name: string; why: 'isFolder' };

/**
 * What uploading `files` into a folder whose entries are `entries` does: the files to send (by their
 * place in `files`), each with `replace` when a file of that name is listed there already (`replaces`:
 * their names, for the user to agree to first), and those refused, with why: a name no system takes, too
 * large, a folder, the same name twice, a folder of that name there, or past the most one pick takes.
 * The server checks each again (another letter case, a file that appeared since).
 */
export function uploadPlan(
  files: PickedFile[],
  entries: FileEntry[],
  limits = FILE_EDIT_LIMITS,
): { send: { index: number; name: string; replace: boolean }[]; replaces: string[]; refused: UploadRefusal[] } {
  const send: { index: number; name: string; replace: boolean }[] = [];
  const refused: UploadRefusal[] = [];
  const seen = new Set<string>();
  files.forEach((f, index) => {
    const problem = fileNameProblem(f.name);
    const listed = entries.find((e) => e.name === f.name);
    if (f.folder) refused.push({ name: f.name, why: 'folder' });
    else if (problem) refused.push({ name: f.name, why: 'name', problem });
    else if (f.size > limits.maxUploadBytes) refused.push({ name: f.name, why: 'size' });
    else if (seen.has(f.name)) refused.push({ name: f.name, why: 'duplicate' });
    else if (listed?.kind === 'dir') refused.push({ name: f.name, why: 'isFolder' });
    else if (send.length >= limits.maxUploadFiles) refused.push({ name: f.name, why: 'tooMany' });
    else send.push({ index, name: f.name, replace: Boolean(listed) });
    seen.add(f.name);
  });
  return { send, replaces: send.filter((s) => s.replace).map((s) => s.name), refused };
}

/** Why a new file's name cannot be used here, as `uploadPlan` would say: a problem with it, or a file or folder of that name. */
export function newFileProblem(name: string, entries: FileEntry[]): FileNameProblem | 'exists' | undefined {
  const problem = fileNameProblem(name);
  if (problem) return problem;
  return entries.some((e) => e.name === name) ? 'exists' : undefined;
}
