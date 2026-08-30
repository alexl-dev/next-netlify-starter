import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * An editable combobox: type freely, or pick from what you have used before.
 *
 * Built to the WAI-ARIA authoring-practices combobox pattern, which matters
 * here for a plain mechanical reason as much as an accessibility one: DOM focus
 * never leaves the input. Moving focus into the list on a phone dismisses the
 * keyboard, and a picker that closes the keyboard every time you press down is
 * unusable. The active option is tracked with `aria-activedescendant` instead.
 *
 * Deliberate choices, each from how these fields actually get used:
 *
 * - **The list opens on focus, before a character is typed.** The empty state
 *   is the whole point — species, flies and methods repeat trip after trip, so
 *   the common case should be one tap and no typing at all.
 * - **Free text always wins.** A fish you have never caught must not be harder
 *   to log than one you have, so nothing is ever forced to match the list.
 * - **No option is auto-selected on open.** Enter with nothing highlighted just
 *   dismisses the list, so it can never quietly overwrite what you typed, and
 *   never submits the form out from under a thumb reaching to dismiss it.
 * - **Matched text is highlighted**, so it is obvious why a row is offered.
 */
export default function Combobox({
  label,
  value,
  onChange,
  onSelect,
  options = [],
  placeholder,
  hint,
  loading = false,
  emptyMessage = null,
  inputMode,
  autoCapitalize = 'none',
  name,
}) {
  const reactId = useId();
  const listId = `${reactId}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // Typing invalidates whichever row was highlighted — the list underneath has
  // just changed, and keeping an index would point at a different value.
  useEffect(() => {
    setActive(-1);
  }, [value]);

  // A tap outside is a dismissal. Pointerdown rather than click, so the list is
  // gone before anything underneath it reacts.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Keep the highlighted row on screen when arrowing past the fold.
  useEffect(() => {
    if (active < 0 || !listRef.current) return;
    const node = listRef.current.children[active];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const commit = useCallback(
    (option) => {
      onChange(option.value);
      if (onSelect) onSelect(option);
      close();
      // Keep the caret where the thumb already is, so a correction needs no
      // second tap on the field.
      if (inputRef.current) inputRef.current.focus();
    },
    [onChange, onSelect, close]
  );

  function handleKeyDown(event) {
    const count = options.length;

    if (event.key === 'ArrowDown' || (event.altKey && event.key === 'ArrowDown')) {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (count) setActive((i) => (i + 1) % count);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (count) setActive((i) => (i <= 0 ? count - 1 : i - 1));
      return;
    }

    if (event.key === 'Home' && open && count) {
      event.preventDefault();
      setActive(0);
      return;
    }

    if (event.key === 'End' && open && count) {
      event.preventDefault();
      setActive(count - 1);
      return;
    }

    if (event.key === 'Enter') {
      // An open list swallows the Enter whether or not a row is highlighted.
      // Otherwise dismissing suggestions would submit the form and log the
      // fish — the same keystroke meaning two things is how you end up with
      // half-filled entries. Closed list, and Enter belongs to the form again.
      if (open) {
        event.preventDefault();
        if (active >= 0 && options[active]) commit(options[active]);
        else close();
      }
      return;
    }

    if (event.key === 'Escape') {
      // Escape closes the list and keeps what was typed. It never reverts the
      // field — losing typing to a stray key is worse than an open list.
      if (open) event.preventDefault();
      close();
    }
  }

  const showList = open && (options.length > 0 || loading || emptyMessage);

  return (
    <div className="combo" ref={rootRef}>
      <label className="field" htmlFor={`${reactId}-input`}>
        {label}
        <input
          id={`${reactId}-input`}
          ref={inputRef}
          name={name}
          type="text"
          role="combobox"
          aria-expanded={showList ? 'true' : 'false'}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && options[active] ? `${reactId}-opt-${active}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize={autoCapitalize}
          spellCheck="false"
          inputMode={inputMode}
          enterKeyHint="done"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
      </label>

      {showList ? (
        <div className="combo-pop">
          {loading ? <p className="combo-status">Searching…</p> : null}
          <ul className="combo-list" role="listbox" id={listId} ref={listRef}>
            {options.map((option, i) => (
              <li
                key={option.id || option.value}
                id={`${reactId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'combo-opt on' : 'combo-opt'}
                // Pointerdown fires before the input's blur, so the tap is not
                // lost to the list unmounting underneath the finger.
                onPointerDown={(e) => {
                  e.preventDefault();
                  commit(option);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="combo-value">
                  <Highlight text={option.label || option.value} range={option.range} />
                </span>
                {option.detail ? <span className="combo-detail">{option.detail}</span> : null}
              </li>
            ))}
          </ul>
          {!loading && !options.length && emptyMessage ? (
            <p className="combo-status">{emptyMessage}</p>
          ) : null}
        </div>
      ) : null}

      {hint ? <p className="tiny muted combo-hint">{hint}</p> : null}

      {/* Announced to a screen reader without stealing the visible layout. */}
      <span className="sr-only" role="status" aria-live="polite">
        {showList && options.length
          ? `${options.length} suggestion${options.length === 1 ? '' : 's'}`
          : ''}
      </span>
    </div>
  );
}

/** Bold the part of the row that matches what was typed. */
function Highlight({ text, range }) {
  if (!range || range.start >= range.end) return <>{text}</>;
  return (
    <>
      {text.slice(0, range.start)}
      <mark>{text.slice(range.start, range.end)}</mark>
      {text.slice(range.end)}
    </>
  );
}
