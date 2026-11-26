import { Check, FileCode2, FolderOpen, LayoutTemplate, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fileGroups, firstFile } from '../domain/factories';
import type {
  Factory,
  FactoryRead,
  FactoryTemplate,
  FactoryVersion,
  TemplatesAnswer,
} from '../domain/factories';
import type { factoryCheckOf } from '../domain/factoryCheck';
import {
  afterSave,
  broughtIn,
  changeSummary,
  contentOf,
  discarded,
  draftOf,
  fileMarks,
  filesOf,
  hasWork,
  heldPaths,
  isChanged,
  pathMoves,
  pathsOf,
  restoreBlocker,
  withEdit,
  withFileAdded,
  withFiles,
  withRemoved,
  withRenamed,
  withRestored,
  withSkillRemoved,
  withSkillRenamed,
} from '../domain/factoryDraft';
import type { FactoryDraft } from '../domain/factoryDraft';
import {
  bodyLine,
  checkNaming,
  FACTORY_YML_SKELETON,
  nameFactsOf,
  namingStart,
  skeletonFor,
} from '../domain/factoryKinds';
import type { NamingTarget } from '../domain/factoryKinds';
import {
  ADD_TEMPLATE,
  bringInLabel,
  broughtInLine,
  changeLine,
  DEFINITION_BANNER_TEXT,
  DEFINITION_BANNER_TITLE,
  discardQuestion,
  FACTORY_GONE,
  FACTORY_PAGE_LABELS,
  fixToSave,
  messageForFactoriesState,
  messageForSave,
  NEW_LABELS,
  NO_FILES,
  NO_FILES_HINT,
  NO_TEMPLATES,
  problemsCount,
  removedSaid,
  restoredSaid,
  savedWords,
  TEMPLATES_LOADING,
  TEMPLATES_NOTE,
  templateAddedLine,
  templateFilesCount,
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
import { closeTab, keptTabs, NO_TABS, openTab, renamedTabs } from '../domain/factoryTabs';
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
 * A factory's definition (`#/factories/<id>/definition`): the whole factory as files, where they
 * are made and kept. It takes the whole width beside the sidebar: a bar with the factory, its
 * version, what Save will do, "Add a template" and Save; the banner, until hidden; then the files
 * beside the editor, its tabs and the problems under it. Files are added by kind (an automation,
 * an agent, a skill, a file inside a skill, `factory.yml`) or from a template, renamed and
 * removed in the tree, and edited in the editor, all a draft until Save sends the whole set as
 * the next version. A factory with no files offers the first ones where the editor would be.
 *
 * The files are read from the API as the page opens (`GET /api/factories/{factoryId}`). A
 * factory the API no longer shows the person reads the sidebar's list again (`onChanged`), which
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
              {read.kind === 'not-found' ? FACTORY_GONE : messageForFactoriesState(read)}
            </p>
            {read.kind === 'unavailable' && (
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
type Checker = { check: typeof factoryCheckOf } | 'loading' | 'failed';

/** A naming field open in the tree: what it makes or renames, and what is typed. */
type Naming = { target: NamingTarget; text: string };

/** Paths renamed in the draft, for the editor to move their kept states: old to new. */
type EditorMoves = { seq: number; moves: Array<[string, string]> };

/** How long the page waits after a keystroke before it checks the files again. */
const CHECK_DELAY_MS = 220;

/** How long Save says Saved, and the problems' head its all-clear. */
const MOMENT_MS = 1800;

/** A newer version than the draft's, saved by someone else: `latest` once it is read. */
type Moved = { latestVersion: number; latest: FactoryVersion | null };

/** The templates offered: closed, being read, or what reading them came to. */
type Templates = { kind: 'closed' } | { kind: 'loading' } | TemplatesAnswer;

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
    const usable = kept && (hasWork(kept.draft) || kept.version.version === initial.version);
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
  const [fromApi, setFromApi] = useState<FactoryProblem[] | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [cleared, setCleared] = useState(false);
  const [nudge, setNudge] = useState(0);
  const [reveal, setReveal] = useState<{
    path: string;
    line: number;
    seq: number;
    flash?: boolean;
  } | null>(null);
  // Every reveal gets a number of its own, so one is never taken for an earlier one.
  const revealSeq = useRef(0);
  const [said, setSaid] = useState('');
  const [naming, setNaming] = useState<Naming | null>(null);
  const [definedAutomations, setDefinedAutomations] = useState<string[]>([]);
  const [editorMoves, setEditorMoves] = useState<EditorMoves | null>(null);
  const [templates, setTemplates] = useState<Templates>({ kind: 'closed' });
  const [templateAdded, setTemplateAdded] = useState<string | null>(null);
  const templatesAsked = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const filterRef = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);

  const paths = useMemo(() => pathsOf(draft), [draft]);
  const marks = useMemo(() => fileMarks(draft), [draft]);
  const changed = useMemo(
    () =>
      new Set(
        [...marks]
          .filter(([, mark]) => mark.isNew || mark.changed || mark.renamedFrom !== null)
          .map(([path]) => path),
      ),
    [marks],
  );
  const summary = useMemo(() => changeSummary(draft), [draft]);
  const removals = useMemo(
    () =>
      draft.removed.map((entry) => ({
        label: entry.label,
        blockedBy: restoreBlocker(draft, entry.label),
      })),
    [draft],
  );
  const facts = useMemo(() => nameFactsOf(draft, definedAutomations), [draft, definedAutomations]);
  const canAddFactoryYml = !heldPaths(draft).has('factory.yml');
  const problems = useMemo(
    () => sortedProblems(fromApi ?? checked, paths),
    [fromApi, checked, paths],
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
      (module) => live && setChecker({ check: module.factoryCheckOf }),
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
        const { problems: found, definedAutomations: defined } = checker.check(filesOf(draft));
        setChecked(found);
        setDefinedAutomations((current) =>
          current.length === defined.length && current.every((name, at) => name === defined[at])
            ? current
            : defined,
        );
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
    // A draft with anything of the person's (a file under Removed included) is brought in, never replaced.
    if (hasWork(draftRef.current)) {
      setMoved((current) =>
        current && current.latestVersion >= listed
          ? current
          : { latestVersion: listed, latest: null },
      );
      return;
    }
    let live = true;
    void factoriesService.loadFactory({ id: workspaceId }, factoryId).then((read) => {
      if (!live || read.kind !== 'found' || hasWork(draftRef.current)) return;
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
    setFromApi(null);
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
        setFromApi(null);
        setTemplateAdded(null);
        setRolled(true);
        setSaving('saved');
        setSaid(`Saved version ${answer.version.version}.`);
        void onChanged();
        return;
      case 'invalid':
        setFromApi(answer.issues.map(problemOf));
        setProblemsOpen(true);
        setSaving('idle');
        setSaid(problemsCount(ownProblems(answer.issues.map(problemOf)).length));
        return;
      case 'version-moved':
        setMoved({ latestVersion: answer.latestVersion, latest: null });
        setSaving('idle');
        return;
      default:
        setSaveError(messageForSave(answer));
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
        setSaveError(read.kind === 'not-found' ? FACTORY_GONE : messageForFactoriesState(read));
        return;
      }
      latestVersion = read.version;
    }
    const result = broughtIn(draftRef.current, latestVersion);
    setVersion(latestVersion);
    apply(() => result.draft);
    setMoved(null);
    setFromApi(null);
    setBrought(broughtInLine(latestVersion.version, result));
  };

  /**
   * A change to the set of files (an add, a rename, a removal, a restore, Discard): the tabs and
   * the editor's kept states follow every file that moved, and a file no longer in the tree loses
   * its tab.
   */
  const apply = (change: (current: FactoryDraft) => FactoryDraft): FactoryDraft => {
    const before = draftRef.current;
    const next = change(before);
    if (next === before) return before;
    draftRef.current = next;
    const moves = pathMoves(before, next);
    setDraft(next);
    setTabs((current) => keptTabs(renamedTabs(current, moves), pathsOf(next)));
    if (moves.size > 0) {
      setEditorMoves((current) => ({ seq: (current?.seq ?? 0) + 1, moves: [...moves] }));
    }
    setFromApi(null);
    setSaveError(null);
    return next;
  };

  const discard = () => {
    apply(discarded);
    setNaming(null);
    setConfirmDiscard(false);
    setSaveError(null);
    setTemplateAdded(null);
  };

  /** Reads the templates the API offers, showing them as they arrive. */
  const loadTemplates = async () => {
    const asked = ++templatesAsked.current;
    setTemplates({ kind: 'loading' });
    const answer = await factoriesService.loadTemplates(ws);
    if (asked === templatesAsked.current) setTemplates(answer);
  };

  const toggleTemplates = () => {
    if (templates.kind !== 'closed') {
      templatesAsked.current++;
      setTemplates({ kind: 'closed' });
      return;
    }
    setTemplateAdded(null);
    void loadTemplates();
  };

  /**
   * Merges a template's files into the files being edited, as unsaved changes (`withFiles`): a
   * file at the same path takes the template's text. The first file it changed opens, and the
   * page says how many it added and replaced; the person saves them with Save.
   */
  const addTemplate = (template: FactoryTemplate) => {
    const result = withFiles(draftRef.current, template.files);
    apply(() => result.draft);
    const touched = [...result.added, ...result.replaced];
    const first = firstFile(fileGroups(touched.map((path) => ({ path }))));
    if (first) setTabs((current) => openTab(current, first));
    templatesAsked.current++;
    setTemplates({ kind: 'closed' });
    const line = templateAddedLine(template.name, result.added, result.replaced, result.skipped);
    setTemplateAdded(line);
    setSaid(line);
  };

  const open = (path: string) => setTabs((current) => openTab(current, path));

  /** A file just made: in a tab, in front, with the caret at the start of its body. */
  const openMade = (path: string, text: string) => {
    open(path);
    setReveal({ path, line: bodyLine(text), seq: ++revealSeq.current, flash: false });
  };

  const startNaming = (target: NamingTarget) => setNaming({ target, text: namingStart(target) });

  /** Enter on a fine name: the file is made, or the file or skill renamed. */
  const commitNaming = () => {
    if (!naming) return;
    const { target, text } = naming;
    const check = checkNaming(target, text, facts);
    if (!check.ok) return;
    setNaming(null);
    switch (target.type) {
      case 'new':
      case 'new-in-skill': {
        const content = skeletonFor(target.type === 'new' ? target.kind : 'skill-file', text);
        const made = apply((current) => withFileAdded(current, check.path, content));
        if (pathsOf(made).includes(check.path)) openMade(check.path, content);
        return;
      }
      case 'rename':
        apply((current) => withRenamed(current, target.path, check.path));
        return;
      case 'rename-skill':
        apply((current) => withSkillRenamed(current, target.skill, text));
        return;
    }
  };

  const addFactoryYml = () => {
    setNaming(null);
    apply((current) => withFileAdded(current, 'factory.yml', FACTORY_YML_SKELETON));
    openMade('factory.yml', FACTORY_YML_SKELETON);
  };

  const remove = (path: string) => {
    apply((current) => withRemoved(current, path));
    setSaid(removedSaid(path));
  };

  const removeSkill = (skill: string) => {
    apply((current) => withSkillRemoved(current, skill));
    setSaid(removedSaid(`skills/${skill}/`));
  };

  const restore = (label: string) => {
    apply((current) => withRestored(current, label));
    setSaid(restoredSaid(label));
  };

  /** A reveal the editor acted on: let go, so an editor mounted later never acts on it again. */
  const revealed = useCallback((seq: number) => {
    setReveal((current) => (current?.seq === seq ? null : current));
  }, []);

  const revealProblem = (problem: FactoryProblem, path: string) => {
    open(path);
    if (problem.line !== null) {
      const line = problem.line;
      setReveal({ path, line, seq: ++revealSeq.current });
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
        {dirty && <p className="definition-changes">{changeLine(summary)}</p>}
        <button
          type="button"
          className="button definition-add-template"
          aria-expanded={templates.kind !== 'closed'}
          disabled={saving === 'saving'}
          onClick={toggleTemplates}
        >
          <LayoutTemplate size={14} aria-hidden="true" />
          {ADD_TEMPLATE}
        </button>
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

      {templates.kind !== 'closed' && (
        <TemplatesStrip
          templates={templates}
          onAdd={addTemplate}
          onRetry={() => void loadTemplates()}
          onClose={toggleTemplates}
        />
      )}
      {templateAdded && (
        <div className="definition-strip" role="status">
          <p>{templateAdded}</p>
          <button
            type="button"
            className="definition-strip-close"
            aria-label="Dismiss"
            onClick={() => setTemplateAdded(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {confirmDiscard && dirty && (
        <div className="definition-strip">
          <p>{discardQuestion(summary.files)}</p>
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

      <div className="workbench">
        <FactoryFileTree
          ref={filterRef}
          paths={paths}
          active={active}
          marks={marks}
          counts={counts}
          removed={removals}
          canAddFactoryYml={canAddFactoryYml}
          naming={naming && { ...naming, check: checkNaming(naming.target, naming.text, facts) }}
          onOpen={open}
          onStartNaming={startNaming}
          onNamingText={(text) => setNaming((current) => current && { ...current, text })}
          onCommitNaming={commitNaming}
          onCancelNaming={() => setNaming(null)}
          onAddFactoryYml={addFactoryYml}
          onRemove={remove}
          onRemoveSkill={removeSkill}
          onRestore={restore}
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
              moves={editorMoves}
              onChange={edit}
              onRevealed={revealed}
            />
          ) : paths.length === 0 ? (
            <div className="definition-empty">
              <FolderOpen size={20} aria-hidden="true" />
              <p className="definition-empty-title">{NO_FILES}</p>
              <p>{NO_FILES_HINT}</p>
              <div className="definition-empty-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => startNaming({ type: 'new', kind: 'automation' })}
                >
                  {NEW_LABELS.automation}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => startNaming({ type: 'new', kind: 'agent' })}
                >
                  {NEW_LABELS.agent}
                </button>
                {canAddFactoryYml && (
                  <button type="button" className="button" onClick={addFactoryYml}>
                    factory.yml
                  </button>
                )}
                {templates.kind === 'closed' && (
                  <button type="button" className="button" onClick={toggleTemplates}>
                    {ADD_TEMPLATE}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="editor-none">Choose a file to read it.</p>
          )}
          <ProblemsPanel
            problems={problems}
            paths={paths}
            open={problemsOpen}
            cleared={cleared}
            nudge={nudge}
            fromApi={fromApi !== null}
            checkFailed={checker === 'failed'}
            onToggle={() => setProblemsOpen((shown) => !shown)}
            onReveal={revealProblem}
          />
        </div>
      </div>
    </>
  );
}

/**
 * The templates offered, under the bar while "Add a template" is open: what adding one does,
 * then each template (its name, how many files, what it is) with Add, or why there are none.
 */
function TemplatesStrip({
  templates,
  onAdd,
  onRetry,
  onClose,
}: {
  templates: Exclude<Templates, { kind: 'closed' }>;
  onAdd: (template: FactoryTemplate) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <section className="definition-strip definition-templates" aria-label="Templates">
      <div className="definition-templates-body">
        <p className="definition-templates-note">{TEMPLATES_NOTE}</p>
        {templates.kind === 'loading' ? (
          <p className="definition-templates-quiet" role="status">
            {TEMPLATES_LOADING}
          </p>
        ) : templates.kind === 'listed' ? (
          templates.templates.length === 0 ? (
            <p className="definition-templates-quiet">{NO_TEMPLATES}</p>
          ) : (
            <ul className="definition-templates-list">
              {templates.templates.map((template) => (
                <li key={template.id} className="definition-template">
                  <div className="definition-template-text">
                    <p className="definition-template-name">
                      {template.name}
                      <span className="definition-template-count">
                        {templateFilesCount(template.files.length)}
                      </span>
                    </p>
                    <p className="definition-template-description">{template.description}</p>
                  </div>
                  <button type="button" className="button primary" onClick={() => onAdd(template)}>
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="definition-templates-refused" role="alert">
            <p>{messageForFactoriesState(templates)}</p>
            {templates.kind === 'unavailable' && (
              <button type="button" className="button" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="definition-strip-close"
        aria-label="Close the templates"
        onClick={onClose}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </section>
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
