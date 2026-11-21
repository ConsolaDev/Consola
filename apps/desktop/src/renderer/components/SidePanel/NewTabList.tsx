import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { type GroupId, NEW_TAB } from '../../sidePanel/layout';
import { newTabOptions, type TabFacts, type TabKindId } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { keyboardAfterClose } from './keyboardAfterClose';

/**
 * The placeholder tab's body: every kind the side panel can show, the ones
 * that apply to the session first, each with its key. Choosing one turns the
 * placeholder into that kind's tab.
 *
 * Its keys are its own: they act only while the list has the keyboard, and
 * never with Cmd, Ctrl or Alt held, so the app's chords pressed here still
 * reach the window. A letter typed anywhere else never chooses a kind.
 */
export function NewTabList({ groupId, facts }: { groupId: GroupId; facts: TabFacts }) {
  const choosePlaceholder = useSidePanelStore((state) => state.choosePlaceholder);
  const closeTab = useSidePanelStore((state) => state.closeTab);
  const listRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const [highlighted, setHighlighted] = useState<TabKindId | null>(null);

  const options = newTabOptions(facts);
  const available = options.filter((option) => option.availability.available);
  // The first available row until the person moves, and again should the one
  // they moved to stop applying.
  const active =
    available.find((option) => option.kind.id === highlighted)?.kind.id ??
    available[0]?.kind.id ??
    null;
  const optionId = (kind: TabKindId) => `${idPrefix}-${kind}`;

  // The list takes the keyboard only when the person's own action just
  // brought it in front on screen (`focusRequest`): "+", a click on its tab,
  // or showing the panel. One that appears at launch, on a session switch,
  // back from an overlay or because the tab before it closed leaves the
  // keyboard where it was: the letters typed for the conversation must stay
  // there. It takes the keyboard at once, and again once the press that
  // asked is over: a press on its tab fronts the tab, and the browser then
  // focuses the tab.
  useEffect(() => {
    if (!useSidePanelStore.getState().takeFocusRequest(NEW_TAB)) return;
    const take = () => listRef.current?.focus();
    take();
    requestAnimationFrame(take);
  }, []);

  const choose = (kind: TabKindId) => choosePlaceholder(groupId, kind);

  const move = (step: 1 | -1) => {
    if (available.length === 0) return;
    const index = available.findIndex((option) => option.kind.id === active);
    const next = (index + step + available.length) % available.length;
    setHighlighted(available[next].kind.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Enter':
        event.preventDefault();
        if (active) choose(active);
        return;
      case 'Escape': {
        event.preventDefault();
        const handOn = keyboardAfterClose(event.currentTarget);
        closeTab(groupId, NEW_TAB);
        // The list took the keyboard with it: hand it on once the close has rendered.
        requestAnimationFrame(() => handOn());
        return;
      }
    }
    const letter = event.key.length === 1 ? event.key.toUpperCase() : null;
    const match = options.find((option) => option.kind.key === letter);
    if (!match) return;
    event.preventDefault();
    if (match.availability.available) choose(match.kind.id);
  };

  const headingId = `${idPrefix}-heading`;
  return (
    <div className="new-tab-list">
      <h2 id={headingId} className="new-tab-list-heading">
        Open in this tab
      </h2>
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-labelledby={headingId}
        aria-activedescendant={active ? optionId(active) : undefined}
        className="new-tab-list-options"
        onKeyDown={onKeyDown}
      >
        {options.map(({ kind, availability }) => {
          const Icon = kind.icon;
          const title = kind.title(facts);
          const reasonId = `${optionId(kind.id)}-reason`;
          const isActive = kind.id === active;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: the listbox has the keyboard and points at its rows with aria-activedescendant; a row only answers the pointer
            <div
              key={kind.id}
              id={optionId(kind.id)}
              role="option"
              aria-label={title}
              aria-selected={isActive}
              aria-disabled={availability.available ? undefined : true}
              aria-describedby={availability.available ? undefined : reasonId}
              aria-keyshortcuts={kind.key}
              className={`new-tab-list-option${isActive ? ' highlighted' : ''}`}
              onMouseEnter={() => {
                if (availability.available) setHighlighted(kind.id);
              }}
              onClick={() => {
                if (availability.available) choose(kind.id);
              }}
            >
              <Icon size={14} aria-hidden="true" className="new-tab-list-icon" />
              <span className="new-tab-list-text">
                <span className="new-tab-list-title">{title}</span>
                {!availability.available && (
                  <span id={reasonId} className="new-tab-list-reason">
                    {availability.reason}
                  </span>
                )}
              </span>
              <kbd className="new-tab-list-key">{kind.key}</kbd>
            </div>
          );
        })}
      </div>
    </div>
  );
}
