import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LANGS, type Lang } from '../shared/types';
import type { Messages } from './locales/zh-TW';

const STORAGE_KEY = 'relay:lang';

/** Each language's messages, loaded when first needed: the page carries only the one it shows. */
const LOAD: Record<Lang, () => Promise<Messages>> = {
  'zh-TW': () => import('./locales/zh-TW').then((m) => m.zhTW),
  en: () => import('./locales/en').then((m) => m.en),
};
const MESSAGES: Partial<Record<Lang, Messages>> = {};

/** The messages in `lang`, loaded once; before the page is drawn, its language's (`main.tsx`). */
export async function loadMessages(lang: Lang): Promise<Messages> {
  return (MESSAGES[lang] ??= await LOAD[lang]());
}

/** Each language named in itself, for the language switch: its `langName`, here so that neither is loaded for it. */
export const LANG_NAMES: Record<Lang, string> = { 'zh-TW': '繁體中文', en: 'English' };

function readSaved(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && (LANGS as string[]).includes(v) ? (v as Lang) : null;
  } catch {
    return null;
  }
}

function save(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

/** The browser's preferred language among ours: any Chinese → zh-TW, otherwise English. */
export function browserLang(prefs: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language]): Lang {
  for (const p of prefs) {
    const v = p.toLowerCase();
    if (v.startsWith('zh')) return 'zh-TW';
    if (v.startsWith('en')) return 'en';
  }
  return 'en';
}

/** Saved choice, else the browser language — remembered from the first visit on. */
function initialLang(): Lang {
  const saved = readSaved();
  if (saved) return saved;
  const detected = browserLang();
  save(detected);
  return detected;
}

let current: Lang = initialLang();

/** Language for code outside React (the API client sends it to the server). */
export function currentLang(): Lang {
  return current;
}

/** The messages in that language, for code outside React (an error the API client makes itself). */
export function currentMessages(): Messages {
  return loaded(current);
}

/** Messages already loaded (`loadMessages`): the page's language is, before anything is drawn. */
function loaded(lang: Lang): Messages {
  const m = MESSAGES[lang];
  if (!m) throw new Error(`messages in ${lang} not loaded`);
  return m;
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Messages;
}

const Ctx = createContext<I18n | null>(null);

function applyToDocument(lang: Lang): void {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  // The other language is loaded first, then shown: the page keeps its words meanwhile.
  const setLang = useCallback((next: Lang) => {
    void loadMessages(next).then(() => {
      current = next;
      save(next);
      setLangState(next);
    });
  }, []);
  useEffect(() => applyToDocument(lang), [lang]);
  const value = useMemo(() => ({ lang, setLang, t: loaded(lang) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

/** The messages of the current language. */
export function useT(): Messages {
  return useI18n().t;
}

export type { Messages };
