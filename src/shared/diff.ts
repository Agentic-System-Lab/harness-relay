/**
 * The note that ends a diff the server cut short (`diffText()` in `src/server/workspace.ts`), with the
 * whole diff's size, which the diff dialog (`src/web/diff.ts`) tells apart from the files: one place
 * for its words, so that the two cannot drift apart.
 */
export function truncatedNote(kb: number): string {
  return `… diff truncated (${kb} KB total)`;
}

export function isTruncatedNote(line: string): boolean {
  return /^… diff truncated \(\d+ KB total\)$/.test(line);
}
