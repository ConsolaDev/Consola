import { AlertTriangle } from 'lucide-react';
import type { AutomationsSnapshot, AutomationView } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { RunNowButton, StatusDot, useIntent } from './parts';
import { formatTime } from './presentation';

/**
 * Every automation in the workspace's factory.yml, one card each: when it
 * fires, what it runs, when it is next due and how it last went. A card opens
 * the automation's panel; its button runs or checks it now. Names, triggers
 * and problems all come from the file, so they are shown as text.
 */
export function AutomationsTab({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const { busy, error, act } = useIntent();

  if (snapshot.automations.length === 0) {
    return (
      <div className="automations-activity">
        <p className="automations-hint">
          No automations in this workspace’s factory.yml yet. Add one from Templates, or start a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="automations-activity">
      {error && <div className="automations-error" role="alert">{error}</div>}
      <ul className="automations-list">
        {snapshot.automations.map((automation) => {
          const lastRun = snapshot.runs.find((run) => run.automationId === automation.name);
          const running = snapshot.runs.some((run) => run.automationId === automation.name && run.status === 'running');
          return (
            <li key={automation.name}>
              <AutomationRow
                automation={automation}
                lastStatus={lastRun?.status}
                running={busy === `run:${automation.name}` || running}
                disabled={busy !== null}
                onOpen={() => openPanel({ kind: 'automation', name: automation.name })}
                onRun={() =>
                  void act(`run:${automation.name}`, () => automationsBridge.runNow(workspace.id, automation.name))
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AutomationRow({
  automation,
  lastStatus,
  running,
  disabled,
  onOpen,
  onRun,
}: {
  automation: AutomationView;
  lastStatus: Parameters<typeof StatusDot>[0]['status'] | undefined;
  running: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRun: () => void;
}) {
  return (
    // The card opens the panel for a pointer; the name is the same action for a keyboard.
    <div className="automations-card automations-card-clickable" onClick={onOpen}>
      <div className="automations-card-main">
        <div className="automations-card-heading">
          {lastStatus ? <StatusDot status={lastStatus} /> : <span className="automations-dot" aria-hidden="true" />}
          <button
            type="button"
            className="automations-link-button automations-name"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            {automation.name}
          </button>
          <span className={`automations-mode automations-mode-${automation.mode}`}>{automation.mode}</span>
          {automation.addedBy?.isNew && (
            <span className="automations-new">New · added by {automation.addedBy.sessionName}</span>
          )}
        </div>
        <div className="automations-meta">
          {automation.trigger}
          {automation.schedule ? (
            <>
              {' '}
              (<code>{automation.schedule}</code>)
            </>
          ) : null}{' '}
          → {automation.runs}
          {automation.kind === 'agent' ? ', read-only' : ''}
        </div>
        {automation.problem ? (
          <div className="automations-problem">
            <AlertTriangle size={12} /> Not running: {automation.problem}
            {automation.line ? ` (line ${automation.line})` : ''}
          </div>
        ) : automation.onEvent ? (
          <div className="automations-meta">Checked on each Inbox refresh</div>
        ) : (
          <div className="automations-meta">
            Next run {automation.nextRunAt ? formatTime(automation.nextRunAt) : 'never'}
          </div>
        )}
      </div>
      <div onClick={(event) => event.stopPropagation()}>
        <RunNowButton automation={automation} running={running} disabled={disabled} onRun={onRun} />
      </div>
    </div>
  );
}
