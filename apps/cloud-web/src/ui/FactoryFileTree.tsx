import { FileCode2, FilePlus, FileText, Folder, Search, Trash2, X } from 'lucide-react';
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { fileGroups, listedPaths } from '../domain/factories';
import {
  deleteFileLabel,
  laterFolderNote,
  NEW_FILE,
  NEW_FILE_HINT,
  NEW_FILE_PATH_LABEL,
  NEW_FILE_PLACEHOLDER,
  NEW_FILE_START_LABELS,
  NO_FILES,
  noFileMatches,
} from '../domain/factoryMessages';
import {
  checkNewFilePath,
  NEW_FILE_STARTS,
  type NewFileStart,
  withStart,
} from '../domain/factoryNewFile';
import { messageParts } from '../domain/factoryProblems';

/**
 * A factory's files as its folder holds them (`fileGroups`: `factory.yml`, then `automations/`,
 * `agents/`, `skills/`), under a filter that narrows them by path as the person types. Each file
 * says whether the person changed it (a dot) and how many problems it has of its own (a count in
 * the danger colour); the one in front is marked as the sidebar marks the open row. Choosing a
 * file opens it in a tab.
 *
 * New file, beside the filter, opens a field for the new file's path (`adding`, the page's, so
 * the empty editor can open it too), checked as the person types (`checkNewFilePath`), with an
 * automation and an agent as one-press starts. A row's delete button shows under the pointer, on
 * the keyboard and on the open row; the file goes from the list until Save, and the keyboard
 * moves to the row beside it.
 */
export const FactoryFileTree = forwardRef<
  HTMLInputElement,
  {
    paths: readonly string[];
    active: string | null;
    changed: ReadonlySet<string>;
    counts: ReadonlyMap<string, number>;
    /** The new file's path as typed, while its field is open; null while it is closed. */
    adding: string | null;
    /** A row to put the keyboard on, as after a delete is undone; a new `seq` asks again. */
    focusRow: { path: string; seq: number } | null;
    onOpen: (path: string) => void;
    onAddingChange: (typed: string | null) => void;
    onAdd: (path: string) => void;
    onDelete: (path: string) => void;
  }
>(function FactoryFileTree(
  { paths, active, changed, counts, adding, focusRow, onOpen, onAddingChange, onAdd, onDelete },
  filterRef,
) {
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const afterDelete = useRef<string | null | undefined>(undefined);
  const fieldId = useId();
  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? paths : paths.filter((path) => path.toLowerCase().includes(needle));
  const groups = fileGroups(shown.map((path) => ({ path })));

  const focusOn = (path: string | null) => {
    const row =
      path === null
        ? null
        : [...(listRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(
            (element) => element.dataset.path === path,
          );
    (row ?? newRef.current)?.focus();
  };

  // A row deleted: the keyboard goes to the row beside it, else to New file, once the list shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the list has changed.
  useEffect(() => {
    if (afterDelete.current === undefined) return;
    const next = afterDelete.current;
    afterDelete.current = undefined;
    focusOn(next);
  }, [paths]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each request, by its `seq`.
  useEffect(() => {
    if (focusRow) focusOn(focusRow.path);
  }, [focusRow]);

  const remove = (path: string) => {
    const listed = listedPaths(shown);
    const at = listed.indexOf(path);
    afterDelete.current = listed[at + 1] ?? listed[at - 1] ?? null;
    onDelete(path);
  };

  return (
    <nav className="file-tree" aria-label="Files">
      <div className="file-tree-head">
        <div className="file-tree-filter">
          <Search size={14} aria-hidden="true" />
          <input
            ref={filterRef}
            type="search"
            value={filter}
            placeholder="Filter files"
            aria-label="Filter files"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filter !== '') {
                event.preventDefault();
                setFilter('');
              }
            }}
          />
          {filter !== '' && (
            <button
              type="button"
              className="file-tree-clear"
              aria-label="Clear the filter"
              onClick={() => setFilter('')}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        <button
          ref={newRef}
          type="button"
          className="file-tree-new"
          aria-label={NEW_FILE}
          title={NEW_FILE}
          aria-expanded={adding !== null}
          aria-controls={adding !== null ? fieldId : undefined}
          onClick={() => onAddingChange(adding === null ? '' : null)}
        >
          <FilePlus size={14} aria-hidden="true" />
        </button>
      </div>
      {adding !== null && (
        <NewFileField
          id={fieldId}
          typed={adding}
          paths={paths}
          onChange={onAddingChange}
          onAdd={onAdd}
          onCancel={() => {
            onAddingChange(null);
            newRef.current?.focus();
          }}
        />
      )}
      <div ref={listRef} className="file-tree-list">
        {paths.length === 0 ? (
          <p className="file-tree-none">{NO_FILES}</p>
        ) : groups.length === 0 ? (
          <p className="file-tree-none">{noFileMatches(filter)}</p>
        ) : (
          groups.map((group) => (
            <FileGroup key={group.folder ?? ''} folder={group.folder}>
              {group.files.map((file) => (
                <li key={file.path} className="file-tree-item">
                  <FileRow
                    path={file.path}
                    name={file.name}
                    needle={needle}
                    active={file.path === active}
                    changed={changed.has(file.path)}
                    count={counts.get(file.path) ?? 0}
                    onOpen={onOpen}
                  />
                  <button
                    type="button"
                    className="file-tree-delete"
                    aria-label={deleteFileLabel(file.path)}
                    title="Delete"
                    onClick={() => remove(file.path)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </FileGroup>
          ))
        )}
      </div>
    </nav>
  );
});

/** Each start's icon: the one its file's tab wears (`EditorTabs`). */
const START_ICONS: Record<NewFileStart['id'], typeof FileCode2> = {
  automation: FileCode2,
  agent: FileText,
};

/**
 * The new file's path, checked as it is typed. What stands in its way is said under it quietly
 * while the person types, and in the danger colour once they press Enter on it; Enter on a path
 * that can be added adds it, Escape closes the field. A start fills its folder and ending around
 * the name typed so far, and puts the caret after the name.
 */
export function NewFileField({
  id,
  typed,
  paths,
  onChange,
  onAdd,
  onCancel,
}: {
  id: string;
  typed: string;
  paths: readonly string[];
  onChange: (typed: string) => void;
  onAdd: (path: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [tried, setTried] = useState(false);
  const [caret, setCaret] = useState<{ at: number; seq: number } | null>(null);
  const noteId = useId();
  const check = checkNewFilePath(typed, paths);
  const refused = check.kind === 'refused' ? check.message : null;
  const loud = tried && refused !== null;

  // The keyboard goes to the path as the field opens: the person asked for it.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A start chosen: the keyboard back in the path, the caret after the name.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!caret || !input) return;
    input.focus();
    input.setSelectionRange(caret.at, caret.at);
  }, [caret]);

  const change = (next: string) => {
    setTried(false);
    onChange(next);
  };

  return (
    <div id={id} className="file-new">
      <input
        ref={inputRef}
        className="file-new-path"
        type="text"
        value={typed}
        placeholder={NEW_FILE_PLACEHOLDER}
        aria-label={NEW_FILE_PATH_LABEL}
        aria-describedby={noteId}
        aria-invalid={loud ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (check.kind === 'ok') onAdd(check.path);
            else setTried(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="file-new-starts">
        {NEW_FILE_STARTS.map((start) => {
          const Icon = START_ICONS[start.id];
          return (
            <button
              key={start.id}
              type="button"
              className="file-new-start"
              onClick={() => {
                const next = withStart(typed, start);
                change(next.value);
                setCaret((current) => ({ at: next.caret, seq: (current?.seq ?? 0) + 1 }));
              }}
            >
              <Icon size={12} aria-hidden="true" />
              {NEW_FILE_START_LABELS[start.id]}
            </button>
          );
        })}
      </div>
      <p id={noteId} className="file-new-note" data-tone={loud ? 'danger' : undefined}>
        {refused !== null ? (
          <Said message={refused} />
        ) : check.kind === 'ok' && check.laterFolder !== null ? (
          <Said message={laterFolderNote(check.laterFolder)} />
        ) : (
          NEW_FILE_HINT
        )}
      </p>
      <span className="sr-only" role="status">
        {loud ? plain(refused) : ''}
      </span>
    </div>
  );
}

/** A sentence with its backticks set as code, as the Problems panel sets them. */
function Said({ message }: { message: string }) {
  return (
    <>
      {messageParts(message).map((part, index) =>
        part.code ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never move.
          <code key={index}>{part.text}</code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never move.
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** A sentence without its backticks, for a screen reader. */
function plain(message: string | null): string {
  return message === null
    ? ''
    : messageParts(message)
        .map((part) => part.text)
        .join('');
}

function FileGroup({ folder, children }: { folder: string | null; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="file-tree-group">
      {folder !== null && (
        <p id={labelId} className="file-tree-folder">
          <Folder size={13} aria-hidden="true" />
          {folder}
        </p>
      )}
      <ul aria-labelledby={folder !== null ? labelId : undefined}>{children}</ul>
    </div>
  );
}

function FileRow({
  path,
  name,
  needle,
  active,
  changed,
  count,
  onOpen,
}: {
  path: string;
  name: string;
  needle: string;
  active: boolean;
  changed: boolean;
  count: number;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="file-tree-row"
      aria-current={active ? 'true' : undefined}
      title={path}
      data-path={path}
      data-nested={path.includes('/') ? '' : undefined}
      onClick={() => onOpen(path)}
    >
      <span className="file-tree-name">
        <Matched text={name} needle={needle} />
      </span>
      {changed && <span className="file-changed" aria-hidden="true" title="Changed" />}
      {count > 0 && (
        <span className="file-problems" aria-hidden="true">
          {count}
        </span>
      )}
      <span className="sr-only">
        {changed ? ', changed' : ''}
        {count > 0 ? `, ${count === 1 ? '1 problem' : `${count} problems`}` : ''}
      </span>
    </button>
  );
}

/** A name with the filter's match set in the text's full weight. */
function Matched({ text, needle }: { text: string; needle: string }) {
  const at = needle === '' ? -1 : text.toLowerCase().indexOf(needle);
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
