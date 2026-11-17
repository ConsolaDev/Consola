import { Hand } from 'lucide-react';
import { isAgentRunPreview, runTitle, type RunListEntry } from '../../../../shared/automations';
import { automationsBridge } from '../../../services/automationsBridge';
import { useAutomationsStore } from '../../../stores/automationsStore';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useIntent } from '../../Automations/parts';
import { idOfKey } from '../../../sidebar/entries';
import type { Entry } from '../../../sidebar/entry';
import type { RowProps } from '../../../sidebar/rowRegistry';

/** Choosing a run opens its detail, where the evidence for deciding is. */
export function activateRun(workspaceId: string, entry: Entry): void {
  useAutomationsStore.getState().openPanel({ kind: 'run', runId: idOfKey(entry.key) });
  useNavigationStore.getState().openAutomations();
}

/**
 * The row for a run waiting for approval: looks its run up by the entry's key,
 * since an entry carries no payload. A run that is gone from the snapshot has
 * no row.
 */
export function RunRow(props: RowProps) {
  const id = idOfKey(props.entry.key);
  const run = useAutomationsStore((state) => state.snapshots[props.workspaceId]?.runs.find((candidate) => candidate.id === id));
  return run ? <RunRowBody run={run} entryKey={props.entry.key} onActivate={props.onActivate} child={props.child} /> : null;
}

/**
 * Approving is offered in place only for an agent run, where what approval
 * runs is the prompt the preview names. Any other run's evidence is a list of
 * what it will change, which the detail shows in full: there the row only
 * links, because an approve button that outruns the evidence is worse than a
 * click more.
 */
export function RunRowBody({ run, entryKey, onActivate, child }: { run: RunListEntry; entryKey?: Entry['key']; onActivate: () => void; child?: boolean }) {
  const { busy, error, act } = useIntent();
  const preview = isAgentRunPreview(run.result) ? run.result : undefined;
  const title = runTitle(run);
  const detail = preview ? [preview.runs, preview.item?.label].filter(Boolean).join(' · ') : run.summary;
  const name = `${title}${detail ? ` — ${detail}` : ''} — waiting for your approval`;

  return (
    <div className={`session-nav-item run-nav-item ${child ? 'session-nav-item--child' : ''}`} data-entry-key={entryKey} title={name}>
      <button type="button" className="run-nav-item-main" aria-label={name} onClick={onActivate}>
        <Hand size={12} className="run-nav-item-icon" aria-hidden="true" />
        <span className="session-nav-item-text">
          <span className="session-nav-item-name">{title}</span>
          {detail && <span className="session-nav-item-subtitle">{detail}</span>}
        </span>
      </button>
      <span className="run-nav-item-actions">
        {preview ? (
          <>
            <button type="button" className="run-nav-item-action" disabled={busy !== null}
              onClick={() => void act('approve', () => automationsBridge.approve(run.id))}>
              {busy === 'approve' ? 'Starting…' : 'Start'}
            </button>
            <button type="button" className="run-nav-item-action" disabled={busy !== null}
              onClick={() => void act('dismiss', () => automationsBridge.dismiss(run.id))}>
              Dismiss
            </button>
          </>
        ) : (
          <button type="button" className="run-nav-item-action" onClick={onActivate}>Review</button>
        )}
      </span>
      {error && <span className="run-nav-item-error" role="alert">{error}</span>}
    </div>
  );
}
