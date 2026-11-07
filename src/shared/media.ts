/*
 * Images and videos an agent shows in the chat: files on this computer, embedded in a reply with
 * Markdown image syntax, e.g. ![chart](out/chart.png). Only these types are ever served; images
 * from other sites stay links, so a reply cannot make the browser contact another site.
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
 * The file path an image's URL points to, when it is a local image or video: a relative or
 * absolute path, or a file: URL. Undefined for other sites (any other scheme, or //host/…).
 */
export function localMediaPath(url: string): string | undefined {
  let path = url.trim();
  if (/^file:/i.test(path)) path = path.replace(/^file:(\/\/(localhost)?)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return undefined;
  path = path.split(/[?#]/)[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as written */
  }
  return path && !path.includes('\0') && mediaType(path) ? path : undefined;
}
