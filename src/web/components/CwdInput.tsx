import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { WorkingDirectories } from '../../shared/types';
import { api } from '../api';
import {
  CWD_MENU_ALL,
  CWD_MENU_CLOSED,
  cwdMenuKey,
  cwdMenuShown,
  cwdMenuToggle,
  cwdMenuTyped,
  cwdHighlight,
  cwdPickIndex,
  cwdTerms,
  matchCwds,
  type CwdMenu,
} from '../cwds';
import { useT } from '../i18n';
import { ChevronIcon } from './icons';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The box's id, for a `<label htmlFor>` beside it. */
  id?: string;
  /** The box's name when no label names it. */
  ariaLabel?: string;
}

/**
 * The working directory box: a text box with a list of the working directories in use (the default
 * one, then the conversations', the most recently used first). The list opens on focus or with the
 * arrow, shows them all at first and, as the user types, only those whose path contains what is typed.
 * The state logic is in `../cwds.ts`. Put it beside its label, not inside one: a `<label>` may hold
 * neither the list nor the arrow button, whose name would become part of the box's.
 */
export function CwdInput({ value, onChange, placeholder, id, ariaLabel }: Props) {
  const t = useT();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLUListElement>(null);
  const [list, setList] = useState<WorkingDirectories | null>(null);
  const [menu, setMenu] = useState<CwdMenu>(CWD_MENU_CLOSED);
  /** The highlight was moved with the keyboard: bring it into view (not when the pointer moved it). */
  const keyed = useRef(false);

  // Asked each time the list opens, so it has the conversations started since; the last answer shows meanwhile.
  useEffect(() => {
    if (!menu.open) return;
    let live = true;
    api.cwds().then(
      (l) => live && setList(l),
      () => {}, // without the list it is a plain text box
    );
    return () => {
      live = false;
    };
  }, [menu.open]);

  const items = list ? matchCwds(list, menu.query) : [];
  const shown = cwdMenuShown(menu, items);
  const at = cwdPickIndex(menu, items);
  const terms = list && menu.query !== null ? cwdTerms(menu.query, list.home) : [];
  const optionId = (i: number) => `${listId}-${i}`;

  // Keep the option highlighted with ↑ ↓ in view by scrolling the list only, never the page or a drawer around it.
  useEffect(() => {
    if (!keyed.current) return;
    keyed.current = false;
    const ul = listEl.current;
    const li = at >= 0 ? (ul?.children[at] as HTMLElement | undefined) : undefined;
    if (!ul || !li) return;
    if (li.offsetTop < ul.scrollTop) ul.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = li.offsetTop + li.offsetHeight - ul.clientHeight;
  }, [shown, at]);

  const open = () => setMenu((m) => (m.open ? m : CWD_MENU_ALL));
  const close = () => setMenu(CWD_MENU_CLOSED);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME (注音/拼音) candidate selection
    const next = cwdMenuKey(menu, e.key, items);
    if (!next.handled) return;
    // The list's key: not the box's, nor a drawer's or dialog's around it (Escape would close it).
    e.preventDefault();
    e.stopPropagation();
    keyed.current = true;
    setMenu(next.menu);
    if (next.choose !== undefined) onChange(next.choose);
  };

  return (
    <div className="cwd-input">
      <input
        ref={input}
        id={id}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && at >= 0 ? optionId(at) : undefined}
        onFocus={open}
        onClick={open}
        onBlur={close}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          onChange(e.target.value);
          setMenu(cwdMenuTyped(e.target.value));
        }}
      />
      <button
        type="button"
        className="cwd-toggle"
        tabIndex={-1}
        aria-label={shown ? t.team.cwdHideList : t.team.cwdShowList}
        aria-expanded={shown}
        aria-controls={listId}
        // Keep the focus in the box, which closes the list when it leaves.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const next = cwdMenuToggle(menu, items);
          setMenu(next);
          if (next.open) input.current?.focus();
        }}
      >
        <ChevronIcon size={15} />
      </button>
      <ul
        ref={listEl}
        id={listId}
        className="cwd-menu"
        role="listbox"
        aria-label={t.team.cwdList}
        hidden={!shown}
        onMouseDown={(e) => e.preventDefault()}
      >
        {shown &&
          items.map((d, i) => (
            <li
              key={d.path}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              className={`${i === at ? 'on' : ''} ${d.path === value.trim() ? 'current' : ''}`}
              title={d.path}
              onMouseMove={() => {
                if (i === at) return;
                keyed.current = false;
                setMenu((m) => ({ ...m, pick: d.path }));
              }}
              onClick={() => {
                onChange(d.path);
                close();
              }}
            >
              <span className="cwd-path">
                {cwdHighlight(d.path, terms).map((p, k) => (p.match ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
              </span>
              {d.default && <span className="cwd-default muted small">{t.team.cwdDefault}</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}
