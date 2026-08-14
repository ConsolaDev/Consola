import { Pencil, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useHarnessStore, type Harness } from '../../stores/harnessStore';
import { describeHarnessStatus, HarnessStatusDot } from './HarnessStatusBadge';
import './styles.css';

/**
 * One configured harness.
 *
 * Shows what the harness resolved to rather than what was typed into it — the
 * version the binary reports and the account its config directory holds — so a
 * misconfigured harness is visible here rather than at session start.
 */
export function HarnessCard({
  harness,
  sessionCount,
  onEdit,
}: {
  harness: Harness;
  /** Sessions still routed through this harness; blocks a clean removal. */
  sessionCount: number;
  onEdit: (harness: Harness) => void;
}) {
  const status = useHarnessStore((state) => state.statuses[harness.id]);
  const probeHarness = useHarnessStore((state) => state.probeHarness);
  const updateHarness = useHarnessStore((state) => state.updateHarness);
  const archiveHarness = useHarnessStore((state) => state.archiveHarness);
  const restoreHarness = useHarnessStore((state) => state.restoreHarness);

  const isProbing = status?.state === 'probing';

  return (
    <div className={`harness-card ${harness.archived ? 'archived' : ''}`}>
      <div className="harness-card-main">
        <span
          className="harness-card-accent"
          style={{ background: harness.accentColor }}
          aria-hidden="true"
        />
        <div className="harness-card-details">
          <div className="harness-card-heading">
            <HarnessStatusDot status={status} />
            <span className="harness-card-name">{harness.name}</span>
            {!harness.isBuiltIn && <code className="harness-card-id">{harness.id}</code>}
            {status?.version && (
              <span className="harness-card-version">v{status.version}</span>
            )}
            {!harness.archived && (
              <button
                type="button"
                className="harness-icon-button"
                onClick={() => void probeHarness(harness.id)}
                disabled={isProbing}
                aria-label={`Re-check ${harness.name}`}
                title="Re-check"
              >
                <RefreshCw size={13} className={isProbing ? 'harness-spin' : ''} />
              </button>
            )}
          </div>
          <span className="harness-card-status">
            {harness.archived
              ? `Archived${sessionCount > 0 ? ` · ${sessionCount} session${sessionCount === 1 ? '' : 's'} still use this` : ''}`
              : describeHarnessStatus(status)}
          </span>
        </div>
      </div>

      <div className="harness-card-actions">
        {harness.archived ? (
          <button
            type="button"
            className="dialog-button-secondary harness-restore-button"
            onClick={() => restoreHarness(harness.id)}
          >
            <RotateCcw size={13} />
            Restore
          </button>
        ) : (
          <>
            <label className="harness-toggle" title="Offer when starting a conversation">
              <input
                type="checkbox"
                checked={harness.enabled}
                onChange={(event) =>
                  updateHarness(harness.id, { enabled: event.target.checked })
                }
                aria-label={`Enable ${harness.name}`}
              />
              <span className="harness-toggle-track" />
            </label>
            <button
              type="button"
              className="harness-icon-button"
              onClick={() => onEdit(harness)}
              aria-label={`Edit ${harness.name}`}
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            {!harness.isBuiltIn && (
              <button
                type="button"
                className="harness-icon-button harness-icon-button-danger"
                onClick={() => archiveHarness(harness.id)}
                aria-label={`Archive ${harness.name}`}
                title={
                  sessionCount > 0
                    ? `Archive — ${sessionCount} existing session${sessionCount === 1 ? '' : 's'} keep using it`
                    : 'Archive'
                }
              >
                <Trash2 size={14} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
