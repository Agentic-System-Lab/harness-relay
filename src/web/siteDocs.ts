import type { Lang } from '../shared/types';
import { HARNESS_RELAY_URL } from './share';

/*
 * Links from the app to the website's docs for people who use it (`site/docs/`, in both languages),
 * for a section of Settings whose setup takes steps outside Harness Relay.
 */

/** The docs' sections the app links to: the page, and the section's id on it (the same in both languages). */
export const SITE_DOCS = {
  renderSetup: { page: 'conversations', anchor: 'render-setup' },
  neonSetup: { page: 'conversations', anchor: 'neon-setup' },
} as const;

/** A docs section's address on the website, in `lang` (the Chinese pages are under `zh-TW/`). */
export function siteDocUrl(lang: Lang, doc: keyof typeof SITE_DOCS): string {
  const { page, anchor } = SITE_DOCS[doc];
  return `${HARNESS_RELAY_URL}${lang === 'zh-TW' ? 'zh-TW/' : ''}docs/${page}/#${anchor}`;
}
