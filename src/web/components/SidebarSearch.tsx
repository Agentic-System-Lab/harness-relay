import { useEffect, useRef, useState } from 'react';
import { highlightParts, searchTerms } from '../../shared/search';
import type { ConversationGroup, SearchResult } from '../../shared/types';
import { api } from '../api';
import type { Route } from '../App';
import { useT } from '../i18n';
import { relativeTime } from '../util';
import { SearchIcon } from './icons';

/** The search field that takes the place of the New group / Search buttons while searching. */
export function SearchBox({
  query,
  onQuery,
  onClose,
  focusToken,
}: {
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
  /** Changes when the field should take the focus again (it also does when it appears). */
  focusToken: number;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);

  return (
    <div className="sidebar-search" role="search">
      <SearchIcon size={16} />
      <input
        ref={input}
        type="search"
        value={query}
        placeholder={t.sidebar.searchPlaceholder}
        aria-label={t.sidebar.searchPlaceholder}
        enterKeyHint="search"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          // Escape ends an IME composition first (Safari: keyCode 229), not the search.
          if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" className="icon-button" onClick={onClose} aria-label={t.sidebar.closeSearch} title={t.sidebar.closeSearch}>
        ×
      </button>
    </div>
  );
}

/** Highlights the words of the search in `text`. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** Conversations that match the search, in place of the groups. */
export function SearchResults({ query, route, groups }: { query: string; route: Route; groups: ConversationGroup[] }) {
  const t = useT();
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState('');
  /** The search the results are for. */
  const [shown, setShown] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const id = ++latest.current;
    // Wait until typing pauses; only the latest search's answer is shown.
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((list) => {
          if (id !== latest.current) return;
          setResults(list);
          setShown(q);
          setError('');
        })
        .catch((e: Error) => {
          if (id === latest.current) setError(e.message);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const terms = searchTerms(shown);
  const groupName = (id?: string) => groups.find((g) => g.id === id)?.name ?? t.sidebar.otherGroup;

  if (error) return <p className="muted small pad">{t.sidebar.searchFailed(error)}</p>;
  if (!results) return <p className="muted small pad">{t.sidebar.searching}</p>;
  return (
    <div className="search-results" aria-live="polite">
      <p className="search-summary">
        {results.length ? t.sidebar.searchCount(results.length) : t.sidebar.noResults(shown)}
        {shown !== query.trim() && <span className="muted"> · {t.sidebar.searching}</span>}
      </p>
      {results.map((r) => {
        const active = route.page === 'chat' && route.id === r.id;
        return (
          <div key={r.id} className={`conv-item search-hit ${active ? 'active' : ''}`}>
            <a href={`#/c/${r.id}`} className="conv-link">
              <span className="conv-title">
                <span className="conv-title-text">
                  <Highlight text={r.title} terms={terms} />
                </span>
              </span>
              {r.snippet && (
                <span className="search-snippet">
                  <Highlight text={r.snippet} terms={terms} />
                </span>
              )}
              <span className="conv-meta">
                <span className="search-group">{groupName(r.groupId)}</span>
                {r.matches > 0 && <span>{t.sidebar.matches(r.matches)}</span>}
                <span>{relativeTime(r.updatedAt, t)}</span>
              </span>
            </a>
          </div>
        );
      })}
    </div>
  );
}
