import type { WorktreeCleanupRules } from '../../../shared/worktreeCleanup';
import { preferencesBridge } from '../../services/preferencesBridge';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { removesMore, RulesEditor } from './RulesEditor';
import { useCleanupActions } from './useCleanupActions';
import './styles.css';

/**
 * Settings → Sessions: the global worktree cleanup rules, every one off by
 * default, with Preview and "Clean up now". A workspace can override them in
 * its own settings.
 */
export function WorktreeCleanupControl() {
  const rules = usePreferencesStore((state) => state.worktreeCleanup);
  const { preview, runNow, changeRules, busy, confirm, results } = useCleanupActions();

  const change = (next: WorktreeCleanupRules) =>
    void changeRules(
      () => preferencesBridge.setWorktreeCleanup(next),
      removesMore(rules, next) ? { global: next } : null,
    );

  return (
    <div className="worktree-cleanup">
      <RulesEditor rules={rules} onChange={change} />
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
          disabled={busy}
          onClick={() => void runNow()}
        >
          Clean up now
        </button>
      </div>
      {results}
      {confirm}
    </div>
  );
}
