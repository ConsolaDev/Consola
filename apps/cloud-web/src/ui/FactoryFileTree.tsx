import { Folder, Search, X } from 'lucide-react';
import { forwardRef, type ReactNode, useId, useState } from 'react';
import { fileGroups } from '../domain/factories';
import { noFileMatches } from '../domain/factoryMessages';

/**
 * A factory's files as its folder holds them (`fileGroups`: `factory.yml`, then `automations/`,
 * `agents/`, `skills/`), under a filter that narrows them by path as the person types. Each file
 * says whether the person changed it (a dot) and how many problems it has of its own (a count in
 * the danger colour); the one in front is marked as the sidebar marks the open row. Choosing a
 * file opens it in a tab.
 */
export const FactoryFileTree = forwardRef<
  HTMLInputElement,
  {
    paths: readonly string[];
    active: string | null;
    changed: ReadonlySet<string>;
    counts: ReadonlyMap<string, number>;
    onOpen: (path: string) => void;
  }
>(function FactoryFileTree({ paths, active, changed, counts, onOpen }, filterRef) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? paths : paths.filter((path) => path.toLowerCase().includes(needle));
  const groups = fileGroups(shown.map((path) => ({ path })));

  return (
    <nav className="file-tree" aria-label="Files">
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
      <div className="file-tree-list">
        {groups.length === 0 ? (
          <p className="file-tree-none">{noFileMatches(filter)}</p>
        ) : (
          groups.map((group) => (
            <FileGroup key={group.folder ?? ''} folder={group.folder}>
              {group.files.map((file) => (
                <li key={file.path}>
                  <FileRow
                    path={file.path}
                    name={file.name}
                    needle={needle}
                    active={file.path === active}
                    changed={changed.has(file.path)}
                    count={counts.get(file.path) ?? 0}
                    onOpen={onOpen}
                  />
                </li>
              ))}
            </FileGroup>
          ))
        )}
      </div>
    </nav>
  );
});

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
