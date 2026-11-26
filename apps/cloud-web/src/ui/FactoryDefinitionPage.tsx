import { Check, FileCode2, FolderOpen, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fileGroups, firstFile } from '../domain/factories';
import type { Factory, FactoryRead, FactoryVersion } from '../domain/factories';
import type { checkFactory } from '../domain/factoryCheck';
import {
  afterSave,
  broughtIn,
  contentOf,
  draftOf,
  filesOf,
  isChanged,
  pathsOf,
  withEdit,
  withoutEdits,
} from '../domain/factoryDraft';
import type { FactoryDraft } from '../domain/factoryDraft';
import {
  bringInLabel,
  broughtInLine,
  DEFINITION_BANNER_TEXT,
  DEFINITION_BANNER_TITLE,
  discardQuestion,
  FACTORY_GONE,
  FACTORY_PAGE_LABELS,
  fixToSave,
  messageForFactoriesState,
  messageForSave,
  NO_FILES,
  NO_FILES_HINT,
  problemsCount,
  savedWords,
  versionMovedLine,
} from '../domain/factoryMessages';
import {
  ownProblems,
  problemCounts,
  problemOf,
  problemPath,
  sortedProblems,
} from '../domain/factoryProblems';
import type { FactoryProblem } from '../domain/factoryProblems';
import { closeTab, keptTabs, NO_TABS, openTab } from '../domain/factoryTabs';
import type { FactoryTabs } from '../domain/factoryTabs';
import type { MyWorkspace } from '../domain/workspace';
import { hideDefinitionBanner, isDefinitionBannerHidden } from '../services/definitionBanner';
import { factoriesService } from '../services/factories';
import { CodeEditor } from './CodeEditor';
import { EditorTabs } from './EditorTabs';
import { FactoryFileTree } from './FactoryFileTree';
import { FactoryTile } from './FactoryTile';
import { keepDefinition, keptDefinition } from './factoryDrafts';
import { ProblemsPanel } from './ProblemsPanel';
import { useNow } from './usePoll';
import './FactoryDefinition.css';

/**
 * A factory's definition (`#/factories/<id>/definition`): the whole factory as files, to read it
 * and to fix it in place. It takes the whole width beside the sidebar: a bar with the factory,
 * its version and Save; the banner, until hidden; then the files beside the editor, its tabs and
 * the problems under it. A factory is made elsewhere (a repository, the setup helper), so files
 * are edited here, never added, renamed or removed.
 *
 * The files are read from the cell as the page opens (`GET /api/factories/{factoryId}`). A
 * factory the cell no longer shows the person reads the sidebar's list again (`onChanged`), which
 * then says it is gone.
 */
export function FactoryDefinitionPage({
  factory,
  personId,
  workspace,
  onChanged,
}: {
  factory: Factory;
  personId: string;
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  const [read, setRead] = useState<FactoryRead | null>(null);
  const latest = useRef(0);
  const factoryId = factory.id;

  const load = useCallback(async () => {
    const asked = ++latest.current;
    const next = await factoriesService.loadFactory({ id: workspace.id }, factoryId);
    if (asked !== latest.current) return;
    setRead(next);
    if (next.kind === 'not-found') await onChanged();
  }, [workspace.id, factoryId, onChanged]);

  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  if (read?.kind === 'found') {
    return (
      <div className="definition">
        <Workbench
          factory={factory}
          personId={personId}
          workspace={workspace}
          initial={read.version}
          onChanged={onChanged}
        />
      </div>
    );
  }

  return (
    <div className="definition">
      <DefinitionBar factory={factory} />
      <div className="definition-state">
        {read === null ? (
          <p className="factory-quiet" role="status">
            Loading its files…
          </p>
        ) : (
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
        )}
      </div>
    </div>
  );
}

/** The checker, loaded late: it carries the YAML parser and the schema. */
type Checker = { check: typeof checkFactory } | 'loading' | 'failed';

/** How long the page waits after a keystroke before it checks the files again. */
const CHECK_DELAY_MS = 220;

/** How long Save says Saved, and the problems' head its all-clear. */
const MOMENT_MS = 1800;

/** A newer version than the draft's, saved by someone else: `latest` once it is read. */
type Moved = { latestVersion: number; latest: FactoryVersion | null };

function Workbench({
  factory,
  personId,
  workspace,
  initial,
  onChanged,
}: {
  factory: Factory;
  personId: string;
  workspace: MyWorkspace;
  initial: FactoryVersion;
  onChanged: () => Promise<void>;
}) {
  const ws = { id: workspace.id };
  const workspaceId = workspace.id;
  const factoryId = factory.id;
  // What the person left here this session, if anything: their edits come back with them.
  const [start] = useState(() => {
    const kept = keptDefinition(workspace.id, factory.id);
    const usable = kept && (isChanged(kept.draft) || kept.version.version === initial.version);
    const version = usable ? kept.version : initial;
    const draft = usable ? kept.draft : draftOf(initial);
    const first = firstFile(fileGroups(filesOf(draft)));
    const tabs = kept
      ? keptTabs(kept.tabs, pathsOf(draft))
      : first
        ? openTab(NO_TABS, first)
        : NO_TABS;
    const moved: Moved | null =
      version.version < initial.version
        ? { latestVersion: initial.version, latest: initial }
        : null;
    return { version, draft, tabs, moved };
  });

  const [version, setVersion] = useState<FactoryVersion>(start.version);
  const [draft, setDraft] = useState<FactoryDraft>(start.draft);
  const [tabs, setTabs] = useState<FactoryTabs>(start.tabs);
  const [moved, setMoved] = useState<Moved | null>(start.moved);
  const [brought, setBrought] = useState<string | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [rolled, setRolled] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [bannerShown, setBannerShown] = useState(() => !isDefinitionBannerHidden());
  const [checker, setChecker] = useState<Checker>('loading');
  const [checked, setChecked] = useState<FactoryProblem[]>([]);
  const [fromCell, setFromCell] = useState<FactoryProblem[] | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [cleared, setCleared] = useState(false);
  const [nudge, setNudge] = useState(0);
  const [reveal, setReveal] = useState<{ path: string; line: number; seq: number } | null>(null);
  const [said, setSaid] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const filterRef = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);

  const paths = useMemo(() => pathsOf(draft), [draft]);
  const changed = useMemo(() => new Set(draft.edits.keys()), [draft]);
  const problems = useMemo(
    () => sortedProblems(fromCell ?? checked, paths),
    [fromCell, checked, paths],
  );
  const own = ownProblems(problems).length;
  const counts = useMemo(() => problemCounts(problems, paths), [problems, paths]);
  const dirty = isChanged(draft);
  const canSave =
    dirty && own === 0 && checker !== 'loading' && saving !== 'saving' && moved === null;

  // Kept while the person is away, so going elsewhere in the dashboard loses nothing.
  useEffect(() => {
    keepDefinition(workspace.id, factory.id, { version, draft, tabs });
  }, [workspace.id, factory.id, version, draft, tabs]);

  // The checker, loaded once the definition opens, so the rest of the dashboard never pays for it.
  useEffect(() => {
    let live = true;
    import('../domain/factoryCheck').then(
      (module) => live && setChecker({ check: module.checkFactory }),
      () => live && setChecker('failed'),
    );
    return () => {
      live = false;
    };
  }, []);

  // The files checked again shortly after the person stops typing.
  const lastOwn = useRef<number | null>(null);
  useEffect(() => {
    if (typeof checker !== 'object') return;
    const timer = window.setTimeout(
      () => {
        const found = checker.check(filesOf(draft));
        setChecked(found);
        const count = ownProblems(found).length;
        if (lastOwn.current !== null && lastOwn.current > 0 && count === 0) setCleared(true);
        if (lastOwn.current !== null && lastOwn.current !== count) setSaid(problemsCount(count));
        lastOwn.current = count;
      },
      lastOwn.current === null ? 0 : CHECK_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [checker, draft]);

  useEffect(() => {
    if (!cleared) return;
    const timer = window.setTimeout(() => setCleared(false), MOMENT_MS);
    return () => window.clearTimeout(timer);
  }, [cleared]);

  useEffect(() => {
    if (saving !== 'saved') return;
    const timer = window.setTimeout(() => setSaving('idle'), MOMENT_MS);
    return () => window.clearTimeout(timer);
  }, [saving]);

  // The sidebar's list read a newer version than this one: someone else saved.
  const listed = factory.latestVersion;
  useEffect(() => {
    if (listed <= version.version || saving === 'saving') return;
    if (isChanged(draftRef.current)) {
      setMoved((current) =>
        current && current.latestVersion >= listed
          ? current
          : { latestVersion: listed, latest: null },
      );
      return;
    }
    let live = true;
    void factoriesService.loadFactory({ id: workspaceId }, factoryId).then((read) => {
      if (!live || read.kind !== 'found' || isChanged(draftRef.current)) return;
      setVersion(read.version);
      setDraft(draftOf(read.version));
      setTabs((current) =>
        keptTabs(
          current,
          read.version.files.map((file) => file.path),
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [listed, version.version, saving, workspaceId, factoryId]);

  const edit = useCallback((path: string, text: string) => {
    setDraft((current) => withEdit(current, path, text));
    setFromCell(null);
    setSaveError(null);
  }, []);

  const save = async () => {
    if (!canSave) return;
    const sent = draft;
    setSaving('saving');
    setSaveError(null);
    setBrought(null);
    const answer = await factoriesService.saveFactory(ws, factory.id, {
      baseVersion: sent.baseVersion,
      files: filesOf(sent),
    });
    switch (answer.kind) {
      case 'saved':
        setVersion(answer.version);
        setDraft((current) => afterSave(current, sent, answer.version));
        setFromCell(null);
        setRolled(true);
        setSaving('saved');
        setSaid(`Saved version ${answer.version.version}.`);
        void onChanged();
        return;
      case 'invalid':
        setFromCell(answer.issues.map(problemOf));
        setProblemsOpen(true);
        setSaving('idle');
        setSaid(problemsCount(ownProblems(answer.issues.map(problemOf)).length));
        return;
      case 'version-moved':
        setMoved({ latestVersion: answer.latestVersion, latest: null });
        setSaving('idle');
        return;
      default:
        setSaveError(messageForSave(answer, workspace));
        setSaving('idle');
        if (answer.kind === 'not-found') {
          // Gone, or now another team's: its edits have nowhere to go, and nothing to ask about.
          keepDefinition(workspaceId, factoryId, null);
          void onChanged();
        }
    }
  };

  /** ⌘S: saves, or shows what stands in the way. */
  const askToSave = () => {
    if (!dirty || saving === 'saving' || moved) return;
    if (own > 0) {
      setProblemsOpen(true);
      setNudge((n) => n + 1);
      setSaid(fixToSave(own));
      return;
    }
    void save();
  };
  const askToSaveRef = useRef(askToSave);
  askToSaveRef.current = askToSave;

  // ⌘S saves from anywhere on the page, and `/` puts the keyboard in the file filter.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        askToSaveRef.current();
        return;
      }
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
      event.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const bringIn = async () => {
    if (!moved) return;
    let latestVersion = moved.latest;
    if (!latestVersion) {
      const read = await factoriesService.loadFactory(ws, factory.id);
      if (read.kind !== 'found') {
        setSaveError(
          read.kind === 'not-found' ? FACTORY_GONE : messageForFactoriesState(read, workspace),
        );
        return;
      }
      latestVersion = read.version;
    }
    const result = broughtIn(draftRef.current, latestVersion);
    setVersion(latestVersion);
    setDraft(result.draft);
    setTabs((current) => keptTabs(current, pathsOf(result.draft)));
    setMoved(null);
    setFromCell(null);
    setBrought(broughtInLine(latestVersion.version, result.bothChanged, result.goneThere));
  };

  const discard = () => {
    setDraft((current) => withoutEdits(current, [...current.edits.keys()]));
    setTabs((current) =>
      keptTabs(
        current,
        version.files.map((file) => file.path),
      ),
    );
    setFromCell(null);
    setConfirmDiscard(false);
    setSaveError(null);
  };

  const open = (path: string) => setTabs((current) => openTab(current, path));

  const revealProblem = (problem: FactoryProblem, path: string) => {
    open(path);
    if (problem.line !== null) {
      const line = problem.line;
      setReveal((current) => ({ path, line, seq: (current?.seq ?? 0) + 1 }));
    }
  };

  const active = tabs.active;
  const activeText = active === null ? undefined : contentOf(draft, active);
  const activeProblems = useMemo(
    () =>
      active === null
        ? []
        : problems
            .filter((problem) => problem.line !== null && problemPath(problem, paths) === active)
            .map((problem) => ({ line: problem.line ?? 1, message: problem.message })),
    [problems, paths, active],
  );
  const saved = savedWords(version, new Date(now), personId);

  return (
    <>
      <DefinitionBar factory={factory}>
        <p className="definition-version">
          Version{' '}
          <span
            key={version.version}
            className="definition-version-number"
            data-rolled={rolled ? '' : undefined}
          >
            {version.version}
          </span>
          {saved && <span className="definition-version-saved">, {saved}</span>}
        </p>
        {dirty && saving !== 'saving' && (
          <button
            type="button"
            className="button definition-discard"
            aria-expanded={confirmDiscard}
            onClick={() => setConfirmDiscard((shown) => !shown)}
          >
            Discard
          </button>
        )}
        <button
          type="button"
          className="button primary definition-save"
          data-state={saving}
          disabled={!canSave}
          title={dirty && own > 0 ? fixToSave(own) : undefined}
          onClick={() => void save()}
        >
          {saving === 'saved' ? (
            <>
              <Check className="definition-save-check" size={14} aria-hidden="true" />
              Saved
            </>
          ) : saving === 'saving' ? (
            'Saving…'
          ) : (
            'Save'
          )}
        </button>
      </DefinitionBar>

      <p className="sr-only" aria-live="polite">
        {said}
      </p>

      {bannerShown && (
        <section className="definition-banner" aria-label="About this page">
          <span className="definition-banner-mark" aria-hidden="true">
            <FileCode2 size={16} />
          </span>
          <div className="definition-banner-text">
            <p className="definition-banner-title">{DEFINITION_BANNER_TITLE}</p>
            <p>{DEFINITION_BANNER_TEXT}</p>
          </div>
          <button
            type="button"
            className="button definition-banner-hide"
            onClick={() => {
              hideDefinitionBanner();
              setBannerShown(false);
            }}
          >
            Don’t show this again
          </button>
        </section>
      )}

      {confirmDiscard && dirty && (
        <div className="definition-strip">
          <p>{discardQuestion(changed.size)}</p>
          <div className="definition-strip-actions">
            <button type="button" className="button" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button type="button" className="button danger" onClick={discard}>
              Discard changes
            </button>
          </div>
        </div>
      )}
      {moved && (
        <div className="definition-strip" role="alert">
          <p>{versionMovedLine(moved.latestVersion)}</p>
          <div className="definition-strip-actions">
            <button type="button" className="button primary" onClick={() => void bringIn()}>
              {bringInLabel(moved.latestVersion)}
            </button>
          </div>
        </div>
      )}
      {brought && (
        <div className="definition-strip" role="status">
          <p>{brought}</p>
          <button
            type="button"
            className="definition-strip-close"
            aria-label="Dismiss"
            onClick={() => setBrought(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {saveError && (
        <div className="definition-strip" data-tone="danger" role="alert">
          <p>{saveError}</p>
        </div>
      )}

      {paths.length === 0 ? (
        <div className="definition-empty">
          <FolderOpen size={20} aria-hidden="true" />
          <p className="definition-empty-title">{NO_FILES}</p>
          <p>{NO_FILES_HINT}</p>
        </div>
      ) : (
        <div className="workbench">
          <FactoryFileTree
            ref={filterRef}
            paths={paths}
            active={active}
            changed={changed}
            counts={counts}
            onOpen={open}
          />
          <div className="editor-pane">
            <EditorTabs
              tabs={tabs}
              changed={changed}
              counts={counts}
              onSelect={open}
              onClose={(path) => setTabs((current) => closeTab(current, path))}
            />
            {active !== null && activeText !== undefined ? (
              <CodeEditor
                path={active}
                text={activeText}
                problems={activeProblems}
                reveal={reveal}
                label={active}
                onChange={edit}
              />
            ) : (
              <p className="editor-none">Choose a file to read it.</p>
            )}
            <ProblemsPanel
              problems={problems}
              paths={paths}
              open={problemsOpen}
              cleared={cleared}
              nudge={nudge}
              fromCell={fromCell !== null}
              checkFailed={checker === 'failed'}
              onToggle={() => setProblemsOpen((shown) => !shown)}
              onReveal={revealProblem}
            />
          </div>
        </div>
      )}
    </>
  );
}

/** The page's bar: the factory, then what the page puts at its end. */
function DefinitionBar({ factory, children }: { factory: Factory; children?: ReactNode }) {
  return (
    <header className="definition-bar">
      <h1 className="definition-crumbs">
        <FactoryTile factory={factory} size={20} />
        <span className="definition-crumb-factory">{factory.name}</span>
        <span className="definition-crumb-sep" aria-hidden="true">
          /
        </span>
        <span className="definition-crumb-page">{FACTORY_PAGE_LABELS.definition}</span>
      </h1>
      {children && <div className="definition-tools">{children}</div>}
    </header>
  );
}
