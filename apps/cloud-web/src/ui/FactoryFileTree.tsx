import { ContextMenu, DropdownMenu } from '@radix-ui/themes';
import { Ellipsis, Folder, Plus, Search, Undo2, X } from 'lucide-react';
import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { fileGroups } from '../domain/factories';
import type { FileEntry, SkillGroup } from '../domain/factories';
import type { FileMark } from '../domain/factoryDraft';
import { kindOfPath, NEW_KINDS, namingParts, namingStart } from '../domain/factoryKinds';
import type { NameCheck, NamingTarget, NewKind } from '../domain/factoryKinds';
import {
  moreLabel,
  NEW_LABELS,
  namingLabel,
  nameSentence,
  newInSkillLabel,
  noFileMatches,
  REMOVED_ON_SAVE,
  renamedTitle,
  restoreBlocked,
} from '../domain/factoryMessages';

/** A naming field open in the tree: what it is for, what is typed, and what that comes to. */
export type TreeNaming = { target: NamingTarget; text: string; check: NameCheck };

/** An entry waiting under "Removed on save", and the file Restore waits on, if any. */
export type TreeRemoval = { label: string; blockedBy: string | null };

/** The kind each format folder's + makes. */
const FOLDER_KINDS: Record<string, NewKind> = {
  automations: 'automation',
  agents: 'agent',
  skills: 'skill',
};

/**
 * A factory's files as its folder holds them (`fileGroups`): `factory.yml`, then `automations/`,
 * `agents/` and `skills/`, which always show, empty or not, so the tree teaches the format; a
 * skill's files sit under the skill. A filter narrows them by path as the person types, and then
 * a folder with no match hides.
 *
 * The tree is where files are made and kept. The + at its top offers each kind (and
 * `factory.yml` while there is none); each folder's + makes its kind, a skill's + a file inside
 * it. Making or renaming opens a naming field in place, the path's fixed parts around it and one
 * sentence under it (`nameSentence`), its description; Enter takes a name only once it is fine,
 * Escape cancels, as does leaving the field with nothing new typed. Each file's ⋯, also on a
 * right-click, renames or deletes it (`factory.yml` only deletes, a skill's `SKILL.md` neither: the
 * skill's own ⋯ acts on its folder); F2 and Delete do the same on the row with the keyboard.
 * Deleted files wait at the foot, under "Removed on save", with Restore.
 *
 * Each file says what Save will do to it: a dot once its text changed, "new" for one the saved
 * version lacks, "renamed" with its old path in the title; and how many problems it has of its
 * own. The one in front is marked as the sidebar marks the open row. Choosing a file opens it in a
 * tab.
 */
export const FactoryFileTree = forwardRef<
  HTMLInputElement,
  {
    paths: readonly string[];
    active: string | null;
    marks: ReadonlyMap<string, FileMark>;
    counts: ReadonlyMap<string, number>;
    removed: readonly TreeRemoval[];
    canAddFactoryYml: boolean;
    naming: TreeNaming | null;
    onOpen: (path: string) => void;
    onStartNaming: (target: NamingTarget) => void;
    onNamingText: (text: string) => void;
    onCommitNaming: () => void;
    onCancelNaming: () => void;
    onAddFactoryYml: () => void;
    onRemove: (path: string) => void;
    onRemoveSkill: (skill: string) => void;
    onRestore: (label: string) => void;
  }
>(function FactoryFileTree(props, filterRef) {
  const { paths, active, marks, counts, removed, naming, onOpen, onStartNaming } = props;
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const matches = (path: string) => needle === '' || path.toLowerCase().includes(needle);
  const groups = fileGroups(
    paths.filter(matches).map((path) => ({ path })),
    {
      formatFolders: needle === '',
    },
  );
  const removedShown = removed.filter((entry) => matches(entry.label));
  const list = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);

  // A naming field opens on the whole tree, so the folder it sits in is never filtered away.
  const target = naming?.target;
  useEffect(() => {
    if (target) setFilter('');
  }, [target]);

  // After a delete, the keyboard moves to the row that took the deleted one's place.
  useLayoutEffect(() => {
    const path = focusNext.current;
    if (path === null) return;
    focusNext.current = null;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-row-path]') ?? [])];
    (rows.find((row) => row.dataset.rowPath === path) ?? rows[0])?.focus();
  });

  /** Removes the rows `gone` picks (a file, or a skill's), keeping the keyboard on the next row. */
  const removing = (gone: (path: string) => boolean, remove: () => void) => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-row-path]') ?? [])].map(
      (row) => row.dataset.rowPath ?? '',
    );
    const first = rows.findIndex(gone);
    const after = rows.slice(first + 1).find((path) => !gone(path));
    focusNext.current = first === -1 ? null : (after ?? rows[first - 1] ?? null);
    remove();
  };

  /** Enter on a fine name: a renamed row keeps the keyboard; a new file's editor takes it. */
  const commitNaming = () => {
    if (naming?.check.ok && naming.target.type === 'rename') {
      focusNext.current = naming.check.path;
    } else if (naming?.check.ok && naming.target.type === 'rename-skill') {
      focusNext.current = `${naming.check.path}SKILL.md`;
    }
    props.onCommitNaming();
  };
  /** Escape: a rename hands the keyboard back to its row. */
  const escapeNaming = () => {
    if (naming?.target.type === 'rename') focusNext.current = naming.target.path;
    else if (naming?.target.type === 'rename-skill') {
      focusNext.current = `skills/${naming.target.skill}/SKILL.md`;
    }
    props.onCancelNaming();
  };
  const namingRow = (open: TreeNaming) => (
    <NamingRow
      naming={open}
      onNamingText={props.onNamingText}
      onCommit={commitNaming}
      onEscape={escapeNaming}
      onLeave={props.onCancelNaming}
    />
  );

  const rowActions = (path: string): Action[] => {
    const kind = kindOfPath(path);
    if (kind === 'skill') return [];
    const remove: Action = {
      label: 'Delete',
      danger: true,
      onSelect: () =>
        removing(
          (row) => row === path,
          () => props.onRemove(path),
        ),
    };
    if (kind === 'factory' || kind === null) return [remove];
    return [{ label: 'Rename', onSelect: () => onStartNaming({ type: 'rename', path }) }, remove];
  };

  const fileRow = (file: FileEntry) => {
    if (naming?.target.type === 'rename' && naming.target.path === file.path) {
      return <li key={file.path}>{namingRow(naming)}</li>;
    }
    return (
      <li key={file.path}>
        <FileItem
          path={file.path}
          name={file.name}
          needle={needle}
          active={file.path === active}
          mark={marks.get(file.path)}
          count={counts.get(file.path) ?? 0}
          actions={rowActions(file.path)}
          onOpen={onOpen}
        />
      </li>
    );
  };

  const newRow = (where: (target: NamingTarget) => boolean) =>
    naming && where(naming.target) ? <li key="naming">{namingRow(naming)}</li> : null;

  const skillGroup = (skill: SkillGroup) => {
    const renaming = naming?.target.type === 'rename-skill' && naming.target.skill === skill.skill;
    const folder = `skills/${skill.skill}/`;
    const actions: Action[] = [
      {
        label: 'Rename skill',
        onSelect: () => onStartNaming({ type: 'rename-skill', skill: skill.skill }),
      },
      {
        label: 'Delete skill',
        danger: true,
        onSelect: () =>
          removing(
            (row) => row.startsWith(folder),
            () => props.onRemoveSkill(skill.skill),
          ),
      },
    ];
    return (
      <li key={skill.skill} className="file-tree-skill">
        {renaming && naming ? (
          namingRow(naming)
        ) : (
          <WithMenu actions={actions}>
            <div className="file-tree-skill-head">
              <Folder size={13} aria-hidden="true" />
              <span className="file-tree-skill-name" id={`skill-${skill.skill}`}>
                <Matched text={skill.skill} needle={needle} />
              </span>
              <button
                type="button"
                className="file-tree-icon-button"
                aria-label={newInSkillLabel(skill.skill)}
                title={newInSkillLabel(skill.skill)}
                onClick={() => onStartNaming({ type: 'new-in-skill', skill: skill.skill })}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
              <MoreMenu label={moreLabel(skill.skill)} actions={actions} />
            </div>
          </WithMenu>
        )}
        <ul aria-labelledby={`skill-${skill.skill}`}>
          {newRow((t) => t.type === 'new-in-skill' && t.skill === skill.skill)}
          {skill.files.map(fileRow)}
        </ul>
      </li>
    );
  };

  const nothingShown = groups.length === 0 && removedShown.length === 0;

  return (
    <nav className="file-tree" aria-label="Files">
      <div className="file-tree-head">
        <span className="file-tree-title">Files</span>
        <NewMenu
          canAddFactoryYml={props.canAddFactoryYml}
          onStartNaming={onStartNaming}
          onAddFactoryYml={props.onAddFactoryYml}
        />
      </div>
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
      <div className="file-tree-list" ref={list}>
        {nothingShown ? (
          <p className="file-tree-none">{noFileMatches(filter)}</p>
        ) : (
          groups.map((group) => {
            const kind = group.folder === null ? undefined : FOLDER_KINDS[group.folder];
            return (
              <FileGroup
                key={group.folder ?? ''}
                folder={group.folder}
                add={
                  kind
                    ? { label: NEW_LABELS[kind], onAdd: () => onStartNaming({ type: 'new', kind }) }
                    : null
                }
              >
                {kind && newRow((t) => t.type === 'new' && t.kind === kind)}
                {group.files.map(fileRow)}
                {group.skills.map(skillGroup)}
              </FileGroup>
            );
          })
        )}
        {removedShown.length > 0 && (
          <RemovedGroup removed={removedShown} needle={needle} onRestore={props.onRestore} />
        )}
      </div>
    </nav>
  );
});

/** A choice in a row's menus. */
type Action = { label: string; danger?: boolean; onSelect: () => void };

/** The + at the tree's top: every kind, and `factory.yml` while the factory has none. */
function NewMenu({
  canAddFactoryYml,
  onStartNaming,
  onAddFactoryYml,
}: {
  canAddFactoryYml: boolean;
  onStartNaming: (target: NamingTarget) => void;
  onAddFactoryYml: () => void;
}) {
  const acted = useRef(false);
  const act = (run: () => void) => () => {
    acted.current = true;
    run();
  };
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button
          type="button"
          className="file-tree-icon-button"
          aria-label="New file"
          title="New file"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        align="end"
        size="1"
        className="file-tree-menu"
        onCloseAutoFocus={(event) => {
          // A naming field takes the keyboard; the menu must not hand it back to the +.
          if (acted.current) event.preventDefault();
          acted.current = false;
        }}
      >
        {NEW_KINDS.map((kind) => (
          <DropdownMenu.Item key={kind} onSelect={act(() => onStartNaming({ type: 'new', kind }))}>
            {NEW_LABELS[kind]}
          </DropdownMenu.Item>
        ))}
        {canAddFactoryYml && (
          <DropdownMenu.Item onSelect={act(onAddFactoryYml)}>factory.yml</DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/**
 * A row's ⋯. It and the right-click menu are not modal: each choice unmounts the row the menu
 * belongs to (Rename swaps it for the naming field, Delete moves it under Removed) while the menu
 * closes, and a modal menu that goes mid-close can leave the page taking no pointer.
 */
function MoreMenu({ label, actions }: { label: string; actions: readonly Action[] }) {
  const acted = useRef(false);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger>
        <button type="button" className="file-tree-icon-button file-tree-more" aria-label={label}>
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        align="end"
        size="1"
        className="file-tree-menu"
        onCloseAutoFocus={(event) => {
          if (acted.current) event.preventDefault();
          acted.current = false;
        }}
      >
        {actions.map((action) => (
          <DropdownMenu.Item
            key={action.label}
            color={action.danger ? 'red' : undefined}
            onSelect={() => {
              acted.current = true;
              action.onSelect();
            }}
          >
            {action.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/** The same choices on a right-click. */
function WithMenu({ actions, children }: { actions: readonly Action[]; children: ReactElement }) {
  const acted = useRef(false);
  if (actions.length === 0) return children;
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Content
        size="1"
        className="file-tree-menu"
        onCloseAutoFocus={(event) => {
          if (acted.current) event.preventDefault();
          acted.current = false;
        }}
      >
        {actions.map((action) => (
          <ContextMenu.Item
            key={action.label}
            color={action.danger ? 'red' : undefined}
            onSelect={() => {
              acted.current = true;
              action.onSelect();
            }}
          >
            {action.label}
          </ContextMenu.Item>
        ))}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

function FileGroup({
  folder,
  add,
  children,
}: {
  folder: string | null;
  add: { label: string; onAdd: () => void } | null;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="file-tree-group">
      {folder !== null && (
        <div className="file-tree-folder">
          <Folder size={13} aria-hidden="true" />
          <span id={labelId}>{folder}</span>
          {add && (
            <button
              type="button"
              className="file-tree-icon-button"
              aria-label={add.label}
              title={add.label}
              onClick={add.onAdd}
            >
              <Plus size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      <ul aria-labelledby={folder !== null ? labelId : undefined}>{children}</ul>
    </div>
  );
}

function FileItem({
  path,
  name,
  needle,
  active,
  mark,
  count,
  actions,
  onOpen,
}: {
  path: string;
  name: string;
  needle: string;
  active: boolean;
  mark: FileMark | undefined;
  count: number;
  actions: readonly Action[];
  onOpen: (path: string) => void;
}) {
  const renamedFrom = mark?.renamedFrom ?? null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const named =
      event.key === 'F2'
        ? actions.find((action) => action.label === 'Rename')
        : event.key === 'Delete' || event.key === 'Backspace'
          ? actions.find((action) => action.label === 'Delete')
          : undefined;
    if (!named) return;
    event.preventDefault();
    named.onSelect();
  };
  return (
    <WithMenu actions={actions}>
      <div className="file-tree-item" data-active={active ? '' : undefined}>
        <button
          type="button"
          className="file-tree-row"
          aria-current={active ? 'true' : undefined}
          title={renamedFrom ? `${path} (${renamedTitle(renamedFrom)})` : path}
          data-row-path={path}
          onClick={() => onOpen(path)}
          onKeyDown={onKeyDown}
        >
          <span className="file-tree-name">
            <Matched text={name} needle={needle} />
          </span>
          {mark?.isNew && (
            <span className="file-mark" data-mark="new" aria-hidden="true">
              new
            </span>
          )}
          {renamedFrom && (
            <span className="file-mark" aria-hidden="true" title={renamedTitle(renamedFrom)}>
              renamed
            </span>
          )}
          {mark?.changed && <span className="file-changed" aria-hidden="true" title="Changed" />}
          {count > 0 && (
            <span className="file-problems" aria-hidden="true">
              {count}
            </span>
          )}
          <span className="sr-only">
            {mark?.isNew ? ', new' : ''}
            {renamedFrom ? `, renamed from ${renamedFrom}` : ''}
            {mark?.changed ? ', changed' : ''}
            {count > 0 ? `, ${count === 1 ? '1 problem' : `${count} problems`}` : ''}
          </span>
        </button>
        <MoreMenu label={moreLabel(path)} actions={actions} />
      </div>
    </WithMenu>
  );
}

/**
 * The naming field, in the folder it makes a file in or in place of the row it renames: the
 * path's fixed parts around it, and its one sentence under it, which is its description and is
 * announced when it refuses a name.
 */
function NamingRow({
  naming,
  onNamingText,
  onCommit,
  onEscape,
  onLeave,
}: {
  naming: TreeNaming;
  onNamingText: (text: string) => void;
  onCommit: () => void;
  /** Escape, or Enter on an empty field: cancelled from the keyboard. */
  onEscape: () => void;
  /** The field left with nothing new typed: cancelled where the person went. */
  onLeave: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const sentenceId = useId();
  const { before, after } = namingParts(naming.target);
  const start = namingStart(naming.target);
  const sentence = nameSentence(naming.target, naming.check);

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    field.select();
  }, []);

  return (
    <div className="file-tree-naming">
      <div className="file-tree-naming-field" data-refused={sentence.refused ? '' : undefined}>
        {before && <span className="file-tree-naming-fixed">{before}</span>}
        <input
          ref={input}
          value={naming.text}
          aria-label={namingLabel(naming.target)}
          aria-describedby={sentenceId}
          aria-invalid={sentence.refused || undefined}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onNamingText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onEscape();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (naming.text === '') onEscape();
              else if (naming.check.ok) onCommit();
            }
          }}
          onBlur={() => {
            if (naming.text === '' || naming.text === start) onLeave();
          }}
        />
        {after && <span className="file-tree-naming-fixed">{after}</span>}
      </div>
      <p
        id={sentenceId}
        className="file-tree-naming-note"
        data-refused={sentence.refused ? '' : undefined}
        aria-live="polite"
      >
        {sentence.text}
      </p>
    </div>
  );
}

/** The foot of the tree: what Save will remove, each with Restore. */
function RemovedGroup({
  removed,
  needle,
  onRestore,
}: {
  removed: readonly TreeRemoval[];
  needle: string;
  onRestore: (label: string) => void;
}) {
  const labelId = useId();
  return (
    <div className="file-tree-group file-tree-removed">
      <p id={labelId} className="file-tree-folder">
        {REMOVED_ON_SAVE}
      </p>
      <ul aria-labelledby={labelId}>
        {removed.map((entry) => (
          <li key={entry.label} className="file-tree-removed-row">
            <span className="file-tree-name" title={entry.label}>
              <Matched text={entry.label} needle={needle} />
            </span>
            <button
              type="button"
              className="file-tree-restore"
              disabled={entry.blockedBy !== null}
              title={entry.blockedBy ? restoreBlocked(entry.blockedBy) : `Restore ${entry.label}`}
              aria-label={`Restore ${entry.label}`}
              onClick={() => onRestore(entry.label)}
            >
              <Undo2 size={12} aria-hidden="true" />
              Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
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
