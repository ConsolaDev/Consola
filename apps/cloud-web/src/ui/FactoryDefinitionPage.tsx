import { Folder } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { fileGroups, firstFile } from '../domain/factories';
import type { Factory, FactoryFile, FactoryRead } from '../domain/factories';
import {
  EDITING_NEXT,
  FACTORY_GONE,
  messageForFactoriesState,
  NO_FILES,
  versionLine,
} from '../domain/factoryMessages';
import type { MyWorkspace } from '../domain/workspace';
import { factoriesService } from '../services/factories';

/**
 * A factory's definition (`#/factories/<id>/definition`): its latest version's files, from the
 * cell (`GET /api/factories/{factoryId}`), read-only for now. A line says which version and when
 * it was saved; the files are listed as the folder holds them (`fileGroups`), and the one chosen
 * is shown beside the list (`FileView`). Editing comes next (CON-74), on this page: its editor
 * takes `FileView`'s place, and nothing else here changes.
 *
 * It reads the factory as it opens; mount it keyed by the factory's latest version, so a new
 * version reads again. A factory the cell no longer shows the person reads the sidebar's list
 * again (`onGone`), which then says it is gone.
 */
export function FactoryDefinitionPage({
  factory,
  workspace,
  onGone,
}: {
  factory: Factory;
  workspace: MyWorkspace;
  onGone: () => Promise<void>;
}) {
  const [read, setRead] = useState<FactoryRead | null>(null);
  const latest = useRef(0);
  const factoryId = factory.id;
  const workspaceId = workspace.id;

  const load = useCallback(async () => {
    const asked = ++latest.current;
    const next = await factoriesService.loadFactory({ id: workspaceId }, factoryId);
    if (asked !== latest.current) return;
    setRead(next);
    if (next.kind === 'not-found') await onGone();
  }, [workspaceId, factoryId, onGone]);

  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  if (read === null) {
    return (
      <p className="factory-quiet" role="status">
        Loading its files…
      </p>
    );
  }

  if (read.kind !== 'found') {
    return (
      <div className="factory-notice">
        <p role="alert">
          {read.kind === 'not-found' ? FACTORY_GONE : messageForFactoriesState(read, workspace)}
        </p>
        {(read.kind === 'pending' || read.kind === 'unavailable') && (
          <button type="button" className="button" onClick={() => void load()}>
            Try again
          </button>
        )}
      </div>
    );
  }

  const { version } = read;
  return (
    <section className="group" aria-labelledby="factory-files-label">
      <div className="factory-files-head">
        <h2 id="factory-files-label" className="group-label">
          {versionLine(version, new Date())}
        </h2>
        <p className="factory-files-note">{EDITING_NEXT}</p>
      </div>
      {version.files.length === 0 ? (
        <div className="group-box factory-files-empty">
          <p>{NO_FILES}</p>
        </div>
      ) : (
        <FileBrowser files={version.files} />
      )}
    </section>
  );
}

/** The files as the folder holds them, beside the one chosen. */
function FileBrowser({ files }: { files: FactoryFile[] }) {
  const groups = fileGroups(files);
  const [chosen, setChosen] = useState<string | null>(() => firstFile(groups));
  const file = files.find((listed) => listed.path === chosen) ?? null;

  return (
    <div className="group-box factory-files">
      <nav className="factory-file-list" aria-label="Files">
        {groups.map((group) => (
          <FileGroup
            key={group.folder ?? ''}
            folder={group.folder}
            files={group.files}
            chosen={chosen}
            onChoose={setChosen}
          />
        ))}
      </nav>
      {file && <FileView key={file.path} file={file} />}
    </div>
  );
}

function FileGroup({
  folder,
  files,
  chosen,
  onChoose,
}: {
  folder: string | null;
  files: { path: string; name: string }[];
  chosen: string | null;
  onChoose: (path: string) => void;
}) {
  const labelId = useId();
  return (
    <div className="factory-file-group">
      {folder !== null && (
        <p id={labelId} className="factory-file-folder">
          <Folder size={12} aria-hidden="true" />
          {folder}/
        </p>
      )}
      <ul aria-labelledby={folder !== null ? labelId : undefined}>
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="factory-file-button"
              aria-current={file.path === chosen ? 'true' : undefined}
              title={file.path}
              onClick={() => onChoose(file.path)}
            >
              {file.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One file's text, read-only: a field the keyboard reaches and scrolls, with no wrapping, as an
 * editor shows code. The editor (CON-74) takes this one's place, with the same file in and Save
 * beside it.
 */
function FileView({ file }: { file: FactoryFile }) {
  const id = useId();
  return (
    <div className="factory-file">
      <label className="factory-file-path" htmlFor={id}>
        {file.path}
        <span className="sr-only">, read-only</span>
      </label>
      <textarea
        id={id}
        className="factory-file-text"
        value={file.content}
        readOnly
        wrap="off"
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}
