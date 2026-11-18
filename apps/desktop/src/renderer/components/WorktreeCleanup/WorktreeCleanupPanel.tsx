import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import {
  type CleanupHistoryEntry,
  effectiveWorktreeCleanup,
  type WorkspaceWorktreeCleanup,
  type WorktreeCleanupRules,
} from '../../../shared/worktreeCleanup';
import { worktreeCleanupBridge } from '../../services/worktreeCleanupBridge';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { CleanupHistoryList } from './CleanupEntries';
import { removesMore, RulesEditor } from './RulesEditor';
import { useCleanupActions } from './useCleanupActions';
import './styles.css';

type Mode = 'inherit' | 'off' | 'custom';

const MODES: Array<{ mode: Mode; label: string; hint: string }> = [
  { mode: 'inherit', label: 'Inherit', hint: 'Use the rules in Settings → Sessions.' },
  { mode: 'off', label: 'Off', hint: 'Never remove a worktree in this workspace.' },
  { mode: 'custom', label: 'Custom', hint: 'Rules of its own for this workspace.' },
];

/**
 * A workspace's worktree cleanup: the global rules, none, or its own; with
 * Preview, "Clean up now" and what was removed or rebuilt here.
 */
export function WorktreeCleanupPanel({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const global = usePreferencesStore((state) => state.worktreeCleanup);
  const override = workspace.worktreeCleanup;
  const mode: Mode = override?.mode ?? 'inherit';
  const effective = effectiveWorktreeCleanup(global, override);
  const { preview, runNow, changeRules, busy, confirm, results } = useCleanupActions(workspace.id);
  const [history, setHistory] = useState<CleanupHistoryEntry[]>([]);

  useEffect(() => {
    let live = true;
    const load = () =>
      void worktreeCleanupBridge.history(workspace.id).then((entries) => {
        if (live) setHistory(entries);
      });
    load();
    const unsubscribe = worktreeCleanupBridge.onChanged(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [workspace.id]);

  const setOverride = (next: WorkspaceWorktreeCleanup | undefined) => {
    const nextEffective = effectiveWorktreeCleanup(global, next);
    void changeRules(
      () => updateWorkspace(workspace.id, { worktreeCleanup: next }),
      removesMore(effective, nextEffective)
        ? { override: { workspaceId: workspace.id, value: next ?? null } }
        : null,
    );
  };

  const choose = (chosen: Mode) => {
    if (chosen === mode) return;
    if (chosen === 'inherit') setOverride(undefined);
    else if (chosen === 'off') setOverride({ mode: 'off' });
    // Custom starts from what applies now, so choosing it changes nothing yet.
    else setOverride({ mode: 'custom', rules: effective ?? global });
  };

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Worktree cleanup</h3>
      </div>
      <p className="ws-panel-hint">
        Remove a session’s worktree when its work is done. A session whose worktree a rule removed
        stays, and its worktree is rebuilt when you open it. Consola never removes a worktree with
        changes, unpushed commits, or files that exist only there.
      </p>
      <div className="ws-choice-list" role="radiogroup" aria-label="Worktree cleanup">
        {MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={mode === option.mode}
            className={`ws-choice-row ${mode === option.mode ? 'selected' : ''}`}
            onClick={() => choose(option.mode)}
          >
            <span className="ws-choice-name">
              {option.label}
              <span className="worktree-cleanup-choice-hint">{option.hint}</span>
            </span>
            {mode === option.mode && <Check size={14} />}
          </button>
        ))}
      </div>
      {override?.mode === 'custom' && (
        <RulesEditor
          rules={override.rules}
          onChange={(rules: WorktreeCleanupRules) => setOverride({ mode: 'custom', rules })}
        />
      )}
      <div className="worktree-cleanup-actions">
        <button
          type="button"
          className="dialog-button-secondary"
          disabled={busy}
          onClick={() => void preview()}
        >
          Preview
        </button>
        <button
          type="button"
          className="dialog-button-secondary"
          disabled={busy || effective === null}
          onClick={() => void runNow()}
        >
          Clean up now
        </button>
      </div>
      {results}
      <h4 className="worktree-cleanup-subtitle">History</h4>
      <CleanupHistoryList entries={history} />
      {confirm}
    </section>
  );
}
