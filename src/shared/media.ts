/*
 * Files on this computer that a reply shows or hands over. Images and videos are embedded with
 * Markdown image syntax, e.g. ![chart](out/chart.png), and only these types are ever shown; images
 * from other sites stay links, so a reply cannot make the browser contact another site. A link to
 * any other local file, e.g. [Slides](out/deck.pptx), becomes a download.
 */

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** The media type of an image or video file, by its extension (undefined for anything else). */
export function mediaType(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? MEDIA_TYPES[ext] : undefined;
}

export function isVideo(path: string): boolean {
  return mediaType(path)?.startsWith('video/') ?? false;
}

/**
 * The file path a link (or an image's URL) in a reply points to, when it is a file on this
 * computer: a relative or absolute path, or a file: URL. A `:line` after a file name is dropped.
 * Undefined for other sites (any other scheme, or //host/…), anchors and folders.
 */
export function localFilePath(url: string): string | undefined {
  // `app.ts:12` is a file and a line, not a URL with the scheme `app.ts:`.
  const withoutLine = (p: string) => p.replace(/^(.*\.[a-z0-9]+):\d+(:\d+)?$/i, '$1');
  let path = url.trim();
  const drive = /^[a-z]:[\\/]/i.test(path); // a Windows path, C:\…
  if (/^file:/i.test(path)) path = path.replace(/^file:(\/\/(localhost)?)?/i, '');
  else if (!drive && (/^[a-z][a-z0-9+.-]*:/i.test(withoutLine(path)) || path.startsWith('//'))) return undefined;
  path = path.split(/[?#]/)[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as written */
  }
  path = withoutLine(path);
  return path && !path.includes('\0') && !/(^|[\\/])\.{0,2}$/.test(path) ? path : undefined;
}

/** The file path an image's URL points to, when it is a local image or video (see `localFilePath`). */
export function localMediaPath(url: string): string | undefined {
  const path = localFilePath(url);
  return path && mediaType(path) ? path : undefined;
}

/** The last part of a path, for naming a download. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
