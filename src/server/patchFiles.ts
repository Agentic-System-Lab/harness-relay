import { resolve } from 'node:path';

/** Read the file headers of a patch that Codex parses with StreamingPatchParser. */
export function patchFilePaths(patch: unknown, cwd: string): string[] {
  if (typeof patch !== 'string') return [];
  const files = new Set<string>();
  const moveMarker = '*** Move to: ';
  let inUpdate = false;
  let canMove = false;
  for (const raw of patch.split('\n')) {
    // Inside Update File, leading spaces mark context lines. Elsewhere Codex trims the header
    // before reading its marker. Neither case trims the path following the marker.
    const endTrimmed = raw.replace(/\p{White_Space}+$/u, '');
    const line = inUpdate ? endTrimmed : endTrimmed.replace(/^\p{White_Space}+/u, '');
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/su.exec(line);
    if (line === '*** End Patch') break;
    if (header) {
      files.add(resolve(cwd, header[2]!));
      inUpdate = header[1] === 'Update';
      canMove = inUpdate;
      continue;
    }
    if (canMove && line.startsWith(moveMarker)) files.add(resolve(cwd, line.slice(moveMarker.length)));
    if (line !== '*** End of File') canMove = false;
  }
  return [...files];
}
