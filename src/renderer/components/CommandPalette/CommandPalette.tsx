import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, Search, SearchX } from 'lucide-react';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import {
  activateSession,
  deleteSessionCompletely,
  openNewSessionComposer,
  renameSession,
  restartSession,
} from '../../utils/sessionActions';
import { CommandPaletteRow, rowElementId } from './CommandPaletteRow';
import { usePaletteContext, usePaletteResults } from './usePaletteResults';
import { SECTION_LABELS, type PaletteItem, type PaletteMode } from './types';
import '../Dialogs/styles.css';
import './styles.css';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ROOT_MODE: PaletteMode = { kind: 'root' };

/** Placeholder and heading text per mode. */
function describeMode(mode: PaletteMode): { title: string | null; placeholder: string } {
  switch (mode.kind) {
    case 'root':
      return { title: null, placeholder: 'Search sessions, workspaces, files and actions…' };
    case 'pick-workspace':
      return { title: 'New session in', placeholder: 'Pick a workspace…' };
    case 'pick-session':
      return {
        title:
          mode.purpose === 'rename'
            ? 'Rename session'
            : mode.purpose === 'delete'
              ? 'Delete session'
              : 'Restart session',
        placeholder: 'Pick a session…',
      };
    case 'pick-harness':
      return { title: 'Set default harness', placeholder: 'Pick a harness…' };
    case 'rename-session':
      return { title: 'Rename session', placeholder: 'New name…' };
  }
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [modeStack, setModeStack] = useState<PaletteMode[]>([ROOT_MODE]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  const mode = modeStack[modeStack.length - 1];
  const context = usePaletteContext();
  const { groups, flat } = usePaletteResults(open, mode, query, context);
  const { title, placeholder } = useMemo(() => describeMode(mode), [mode]);

  // Row position comes from the flat list rather than being recounted while
  // rendering groups, so keyboard indexes cannot drift from what is drawn.
  const rowIndexById = useMemo(
    () => new Map(flat.map((item, index) => [item.id, index])),
    [flat]
  );

  // The palette is a fire-and-forget tool: every open starts from scratch.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setModeStack([ROOT_MODE]);
    setSelectedIndex(0);
  }, [open]);

  // A new mode or query means the old selection no longer refers to anything.
  useEffect(() => {
    setSelectedIndex(0);
  }, [mode, query]);

  // Results can shrink under a selection that was valid a keystroke ago.
  useEffect(() => {
    setSelectedIndex((current) => (current >= flat.length ? Math.max(0, flat.length - 1) : current));
  }, [flat.length]);

  useEffect(() => {
    rowRefs.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, flat]);

  const registerRef = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(index, element);
    else rowRefs.current.delete(index);
  }, []);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const pushMode = useCallback((next: PaletteMode) => {
    setModeStack((stack) => [...stack, next]);
    setQuery('');
  }, []);

  const popMode = useCallback(() => {
    setModeStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
    setQuery('');
  }, []);

  /** Act on a session chosen in a picker. */
  const handlePickedSession = useCallback(
    (item: PaletteItem, purpose: 'rename' | 'delete' | 'restart') => {
      if (item.kind !== 'session') return;
      const workspace = useWorkspaceStore.getState().getWorkspace(item.workspaceId);
      const session = workspace?.sessions.find((candidate) => candidate.id === item.sessionId);
      if (!workspace || !session) return;

      if (purpose === 'rename') {
        // The search box becomes the edit field rather than dropping to a
        // native prompt, so renaming stays inside the palette.
        setModeStack((stack) => [
          ...stack,
          { kind: 'rename-session', workspaceId: workspace.id, sessionId: session.id },
        ]);
        setQuery(session.name);
        requestAnimationFrame(() => inputRef.current?.select());
        return;
      }

      if (purpose === 'delete') {
        const confirmed = window.confirm(
          `Delete session "${session.name}"? This will remove the session and its chat history.`
        );
        // Staying in the picker on cancel means a misfire costs one keystroke.
        if (!confirmed) return;
        deleteSessionCompletely(workspace.id, session);
        close();
        return;
      }

      restartSession(session.instanceId);
      activateSession(workspace.id, session.id);
      close();
    },
    [close]
  );

  const activate = useCallback(
    (item: PaletteItem) => {
      switch (mode.kind) {
        case 'pick-workspace':
          if (item.kind === 'workspace') {
            openNewSessionComposer(item.workspaceId);
            close();
          }
          return;

        case 'pick-session':
          handlePickedSession(item, mode.purpose);
          return;

        case 'pick-harness':
          if (item.kind === 'harness') {
            useWorkspaceStore
              .getState()
              .updateWorkspace(mode.workspaceId, { defaultHarnessId: item.harnessId });
            close();
          }
          return;

        default:
          break;
      }

      if (item.kind === 'action') {
        if (item.pushMode) {
          pushMode(item.pushMode);
          return;
        }
        close();
        void item.run?.();
        return;
      }

      if (item.kind === 'session') {
        activateSession(item.workspaceId, item.sessionId);
        close();
        return;
      }

      if (item.kind === 'workspace') {
        useNavigationStore.getState().setActiveWorkspace(item.workspaceId);
        close();
        return;
      }

      if (item.kind === 'file') {
        // Opening a diff needs the review panel, which lives in the content view.
        useGitReviewStore.getState().open();
        useGitReviewStore.getState().setFileExpanded(item.relativePath, true);
        useGitReviewStore.getState().setScrollToFile(item.relativePath);
        usePreviewTabStore
          .getState()
          .openDiff(item.rootPath, item.relativePath, item.status === 'staged');
        close();
      }
    },
    [mode, close, pushMode, handlePickedSession]
  );

  const commitRename = useCallback(() => {
    if (mode.kind !== 'rename-session') return;
    const workspace = useWorkspaceStore.getState().getWorkspace(mode.workspaceId);
    const session = workspace?.sessions.find((candidate) => candidate.id === mode.sessionId);
    if (workspace && session) renameSession(workspace.id, session, query);
    close();
  }, [mode, query, close]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (mode.kind === 'rename-session') {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRename();
      }
      // Escape is handled by onEscapeKeyDown; Radix closes on it otherwise.
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (flat.length > 0) setSelectedIndex((current) => (current + 1) % flat.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (flat.length > 0) {
          setSelectedIndex((current) => (current - 1 + flat.length) % flat.length);
        }
        break;
      case 'Home':
        event.preventDefault();
        setSelectedIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setSelectedIndex(Math.max(0, flat.length - 1));
        break;
      case 'Enter': {
        event.preventDefault();
        const item = flat[selectedIndex];
        if (item) activate(item);
        break;
      }
      case 'Backspace':
        if (query.length === 0 && modeStack.length > 1) {
          event.preventDefault();
          popMode();
        }
        break;
      default:
        break;
    }
  };

  const isRenaming = mode.kind === 'rename-session';
  const selectedItem = flat[selectedIndex];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="command-palette-content"
          onKeyDown={handleKeyDown}
          // Radix focuses the first tabbable child; the input must win.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          // Escape steps back out of a sub-picker before it closes the
          // palette. Radix dismisses on Escape from a document listener, so
          // this is the only place that can intercept it.
          onEscapeKeyDown={(event) => {
            if (modeStack.length > 1) {
              event.preventDefault();
              popMode();
            }
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>

          <div className="command-palette-input-row">
            {modeStack.length > 1 ? (
              <button
                type="button"
                className="command-palette-back"
                onClick={popMode}
                aria-label="Back"
                tabIndex={-1}
              >
                <ChevronLeft size={16} />
              </button>
            ) : (
              <Search size={16} className="command-palette-search-icon" />
            )}

            {title && <span className="command-palette-mode-title">{title}</span>}

            <input
              ref={inputRef}
              className="command-palette-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              // Renaming turns this into an ordinary text field: there is no
              // listbox rendered then, so the combobox roles would point at
              // an element that does not exist.
              role={isRenaming ? undefined : 'combobox'}
              aria-expanded={isRenaming ? undefined : flat.length > 0}
              aria-controls={isRenaming ? undefined : 'command-palette-listbox'}
              aria-autocomplete={isRenaming ? undefined : 'list'}
              aria-activedescendant={
                !isRenaming && selectedItem ? rowElementId(selectedItem.id) : undefined
              }
              aria-label={isRenaming ? 'New session name' : undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {isRenaming ? (
            <div className="command-palette-hint">
              <kbd>Enter</kbd> to rename · <kbd>Esc</kbd> to go back
            </div>
          ) : (
            <>
              <div
                id="command-palette-listbox"
                role="listbox"
                aria-label="Command palette results"
                className="command-palette-list"
              >
                {groups.map((group) => (
                  <div key={group.section} role="group" aria-labelledby={`cp-header-${group.section}`}>
                    <div
                      id={`cp-header-${group.section}`}
                      role="presentation"
                      className="command-palette-section-header"
                    >
                      {SECTION_LABELS[group.section]}
                    </div>
                    {group.items.map((item) => {
                      const rowIndex = rowIndexById.get(item.id) ?? -1;
                      return (
                        <CommandPaletteRow
                          key={item.id}
                          item={item}
                          index={rowIndex}
                          isSelected={rowIndex === selectedIndex}
                          query={query}
                          onHover={setSelectedIndex}
                          onSelect={activate}
                          registerRef={registerRef}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>

              {flat.length === 0 && (
                <div className="command-palette-empty" role="status" aria-live="polite">
                  <SearchX size={16} />
                  <span>No results{query.trim() ? ` for "${query.trim()}"` : ''}</span>
                </div>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
