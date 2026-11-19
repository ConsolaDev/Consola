import { useState } from 'react';
import { AlarmClock, ArrowLeftRight, Gauge } from 'lucide-react';
import { describeWake } from '../../../shared/snooze';
import { sessionLabel } from '../../../shared/sessionLabel';
import { useMinuteTick } from '../../hooks/useMinuteTick';
import { useSessionAttention } from '../../stores/attentionStore';
import { useSessionUsageLimit } from '../../stores/usageLimitsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { snoozeWithUndo } from '../../utils/snoozeActions';
import { SwitchHarnessDialog } from '../Dialogs/SwitchHarnessDialog';
import './styles.css';

/**
 * A strip above a session's terminal while it is stopped on its harness's
 * usage limit: when the limit resets, as the CLI said, and the two ways on.
 * Consola types nothing at the reset; the person decides.
 */
export function UsageLimitNotice({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) {
  const limit = useSessionUsageLimit(sessionId);
  const attention = useSessionAttention(sessionId);
  const session = useWorkspaceStore((state) =>
    state.workspaces
      .find((candidate) => candidate.id === workspaceId)
      ?.sessions.find((candidate) => candidate.id === sessionId),
  );
  const [switching, setSwitching] = useState(false);
  const now = useMinuteTick(limit !== undefined);
  if (!limit || !session) return null;
  const resets = limit.resetsAt !== undefined && limit.resetsAt > now ? limit.resetsAt : undefined;
  const name = sessionLabel(session);

  return (
    <div className="usage-limit-notice" role="status">
      <Gauge size={13} aria-hidden="true" />
      <span className="usage-limit-notice-text">
        Stopped on its usage limit
        {resets !== undefined
          ? `. It resets ${describeWake(resets, now)}.`
          : '. The CLI gave no reset time.'}
      </span>
      {resets !== undefined && attention !== 'snoozed' && (
        <button
          type="button"
          className="usage-limit-notice-button"
          onClick={() =>
            void snoozeWithUndo(
              workspaceId,
              [sessionId],
              { untilLimitResets: true },
              {
                [sessionId]: name,
              },
            )
          }
        >
          <AlarmClock size={12} aria-hidden="true" />
          <span>Snooze until reset</span>
        </button>
      )}
      {session.kind === 'interactive' && (
        <button
          type="button"
          className="usage-limit-notice-button"
          onClick={() => setSwitching(true)}
        >
          <ArrowLeftRight size={12} aria-hidden="true" />
          <span>Switch harness…</span>
        </button>
      )}
      {switching && (
        <SwitchHarnessDialog
          workspaceId={workspaceId}
          session={session}
          onClose={() => setSwitching(false)}
        />
      )}
    </div>
  );
}
