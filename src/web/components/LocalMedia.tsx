import { useState } from 'react';
import { isVideo } from '../../shared/media';
import { useT } from '../i18n';

/** An image or video from this computer that a reply embeds (served by /media; see shared/media.ts). */
export function LocalMedia({ src, path, alt }: { src: string; path: string; alt: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const name = path.split('/').pop() || path;

  if (failed) {
    return (
      <span className="media-missing" title={path}>
        {t.message.mediaMissing(path)}
      </span>
    );
  }
  if (isVideo(path)) {
    return (
      <video className="chat-media" src={src} controls preload="metadata" title={alt || name} onError={() => setFailed(true)}>
        {alt}
      </video>
    );
  }
  return (
    <a className="chat-media-link" href={src} target="_blank" rel="noreferrer" title={t.message.openImage(alt || name)}>
      <img className="chat-media" src={src} alt={alt || name} loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}
