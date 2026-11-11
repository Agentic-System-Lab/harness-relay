import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { WorkingDirectories } from '../../shared/types';
import { api } from '../api';
import {
  CWD_MENU_ALL,
  CWD_MENU_CLOSED,
  addCwds,
  cwdChipKey,
  cwdMenuKey,
  cwdMenuShown,
  cwdMenuToggle,
  cwdMenuTyped,
  cwdHighlight,
  cwdPickIndex,
  cwdTerms,
  hasCwd,
  matchCwds,
  pickStart,
  removeCwd,
  type CwdMenu,
} from '../cwds';
import { useT } from '../i18n';
import { ChevronIcon, EnterIcon, FolderIcon } from './icons';

interface Props {
  /** The working directories, the first where the agents start. */
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** The text box's id, for a `<label htmlFor>` beside it. */
  id?: string;
  /** The text box's name when no label names it. */
  ariaLabel?: string;
}

/**
 * The working directories box: each working directory is a chip (× takes it out), followed by a text
 * box. Typing a path and pressing Enter (or leaving the box) adds it; while something is typed, an
 * Enter key at the end of the box says so (a click on it adds it too, for touch screens). Backspace in
 * the empty box takes out the last. Below it is a list of the working directories in use (the default ones, then the
 * conversations', the most recently used first), which opens on focus or with the arrow, shows them
 * all at first and, as the user types, only those whose path contains what is typed; choosing one
 * adds it. While the box has the focus, a folder button beside the arrow opens this computer's own
 * folder dialog, when the browser runs on the computer the server runs on (`pick` in the list's
 * answer): the folders chosen there are added. The state logic is in `../cwds.ts`. Put it beside its
 * label, not inside one: a `<label>` may hold neither the list nor the buttons, whose names would
 * become part of the box's.
 */
export function CwdInput({ value, onChange, placeholder, id, ariaLabel }: Props) {
  const t = useT();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLUListElement>(null);
  /** What is typed, not added yet. */
  const [text, setText] = useState('');
  const [list, setList] = useState<WorkingDirectories | null>(null);
  const [menu, setMenu] = useState<CwdMenu>(CWD_MENU_CLOSED);
  /** The highlight was moved with the keyboard: bring it into view (not when the pointer moved it). */
  const keyed = useRef(false);
  /** The folder dialog is open. */
  const [picking, setPicking] = useState(false);
  /** Its request: stopped (the server then closes the dialog) when the box goes away. */
  const pickRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pickRequest.current?.abort(), []);

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

  /** Adds folders (what was typed, a path from the list, the dialog's), each once; what was typed is cleared. */
  const add = (dirs: string[]) => {
    const next = addCwds(value, dirs);
    if (next.length !== value.length) onChange(next);
    setText('');
  };

  /** Opens the folder dialog at what is typed (else the last folder); the folders chosen there are added. */
  const pick = () => {
    if (pickRequest.current) return;
    const ctl = new AbortController();
    pickRequest.current = ctl;
    setPicking(true);
    const start = pickStart(value, text);
    // Out of the box (what is typed is added), so the list does not open again when the dialog gives
    // the window back its focus.
    close();
    input.current?.blur();
    api
      .pickCwd(start, ctl.signal)
      .then(
        (r) => {
          if (r.paths.length && !ctl.signal.aborted) add(r.paths);
        },
        (err) => {
          if (!ctl.signal.aborted) alert((err as Error).message);
        },
      )
      .finally(() => {
        pickRequest.current = null;
        setPicking(false);
      });
  };

  /** A click on the box around the chips and the text box (not on them) goes to the text box. */
  const focusBox = (e: MouseEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    input.current?.focus();
    open();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME (注音/拼音) candidate selection
    const next = cwdMenuKey(menu, e.key, items);
    if (next.handled) {
      // The list's key: not the box's, nor a drawer's or dialog's around it (Escape would close it).
      e.preventDefault();
      e.stopPropagation();
      keyed.current = true;
      setMenu(next.menu);
      if (next.choose !== undefined) add([next.choose]);
      return;
    }
    const chips = cwdChipKey(value, text, e.key);
    if (!chips) return;
    // Enter adds the folder rather than submitting a form around the box.
    e.preventDefault();
    e.stopPropagation();
    if (chips.dirs.length !== value.length) onChange(chips.dirs);
    setText(chips.text);
    setMenu(CWD_MENU_ALL);
  };

  return (
    <div className={`cwd-input ${list?.pick ? 'can-pick' : ''}`} onMouseDown={focusBox}>
      {value.map((dir, i) => (
        <span key={dir} className="cwd-chip" title={dir}>
          <span className="cwd-chip-path">{dir}</span>
          <button
            type="button"
            className="cwd-chip-remove"
            aria-label={t.team.cwdRemove(dir)}
            // Keep the focus in the box, so the list stays where it is.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(removeCwd(value, i))}
          >
            ×
          </button>
        </span>
      ))}
      {/* The text box is as wide as what is typed (the hidden copy of it in `data-value` sets the
          width), so the Enter key right after it follows the last character. */}
      <span className="cwd-entry" onMouseDown={focusBox}>
        <span className="cwd-typing" data-value={text || (value.length ? t.team.cwdAddMore : placeholder) || ''}>
          <input
            ref={input}
            id={id}
            aria-label={ariaLabel}
            value={text}
            placeholder={value.length ? t.team.cwdAddMore : placeholder}
            // The smallest box by itself: its width comes from what is typed.
            size={1}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={shown}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown && at >= 0 ? optionId(at) : undefined}
            onFocus={open}
            onClick={open}
            onBlur={() => {
              close();
              // What was typed and left is a folder too, as a single path was before.
              if (text.trim()) add([text]);
            }}
            onKeyDown={onKeyDown}
            onChange={(e) => {
              setText(e.target.value);
              setMenu(cwdMenuTyped(e.target.value));
            }}
          />
        </span>
        {text.trim() && (
          <button
            type="button"
            className="cwd-enter"
            aria-label={t.team.cwdEnter}
            title={t.team.cwdEnter}
            // Keep the focus in the box, for the next folder.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              add([text]);
              setMenu(CWD_MENU_ALL);
            }}
          >
            <EnterIcon size={14} />
          </button>
        )}
      </span>
      {list?.pick && (
        <button
          type="button"
          className={`cwd-pick ${picking ? 'busy' : ''}`}
          aria-label={t.team.cwdPick}
          title={t.team.cwdPick}
          aria-busy={picking || undefined}
          disabled={picking}
          // Keep the focus in the box until the dialog opens.
          onMouseDown={(e) => e.preventDefault()}
          onClick={pick}
        >
          <FolderIcon size={15} />
        </button>
      )}
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
              className={`${i === at ? 'on' : ''} ${hasCwd(value, d.path) ? 'current' : ''}`}
              title={d.path}
              onMouseMove={() => {
                if (i === at) return;
                keyed.current = false;
                setMenu((m) => ({ ...m, pick: d.path }));
              }}
              // The list stays open, for another folder.
              onClick={() => add([d.path])}
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
