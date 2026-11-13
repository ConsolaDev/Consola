import type { ReactNode } from 'react';
import {
  Bell,
  Bot,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  Hand,
  Hourglass,
  Inbox,
  LoaderCircle,
  Play,
  ScanSearch,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { isAgentRunPreview, type RunRecord } from '../../../shared/automations';
import { formatElapsed } from './presentation';
import { foundNothingToDo, type RunStage, type RunStageKey, type RunStageState } from './runPage';

const STATE_ICONS: Record<RunStageState, LucideIcon> = {
  passed: CircleCheck,
  failed: CircleX,
  stopped: CircleSlash,
  waiting: Hand,
  queued: Clock,
  running: LoaderCircle,
  skipped: CircleDashed,
  pending: CircleDashed,
};

/** The pipeline graph's own classes for the states it already draws: the flowing arrow, the amber wait. */
const LIVE_CLASSES: Partial<Record<RunStageState, string>> = {
  waiting: 'automations-node-waiting',
  queued: 'automations-node-queued',
  running: 'automations-node-running',
};

/**
 * One run as a CI service draws a run of a pipeline: its stages left to
 * right (top to bottom when narrow), each marked with how the run went
 * through it, so where it broke — or where it stands now — is the node
 * that is not green. A stage with a section on the page (its steps, its
 * output, what broke) is a link to it.
 */
export function RunGraph({
  run,
  stages,
  place,
  askerName,
  schedule,
  targets,
  onReveal,
}: {
  run: RunRecord;
  stages: RunStage[];
  /** A queued run's place in line. */
  place?: number;
  /** The session that asked, for an agent's request. */
  askerName?: string;
  /** The automation's schedule in words ("Weekdays at 9:00"), while factory.yml still has it. */
  schedule?: string;
  /** The id of the section each stage links to, where it has one. */
  targets: Partial<Record<RunStageKey, string>>;
  onReveal: (id: string) => void;
}) {
  return (
    <ol className="automations-pipeline automations-pipeline-run" aria-label="Stages of this run">
      {stages.map((stage) => {
        const view = stageView(run, stage, place, askerName, schedule);
        const StateIcon = STATE_ICONS[stage.state];
        const target = targets[stage.key];
        return (
          <li
            key={stage.key}
            className={`automations-node automations-stage-${stage.state} ${LIVE_CLASSES[stage.state] ?? ''}`}
            aria-label={`${view.kicker}: ${view.outcome}`}
          >
            <div className="automations-node-kicker">
              <view.icon size={13} aria-hidden="true" />
              {view.kicker}
            </div>
            <div className="automations-node-title">
              {target ? (
                <button type="button" className="automations-node-link" onClick={() => onReveal(target)}>
                  {view.title}
                </button>
              ) : (
                view.title
              )}
            </div>
            <div className="automations-node-foot">
              <StateIcon
                size={13}
                className={`automations-stage-icon ${stage.state === 'running' ? 'automations-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{view.outcome}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface StageView {
  icon: LucideIcon;
  kicker: string;
  title: ReactNode;
  outcome: string;
}

/** What one node says: the kind of stage, what it was in this run, and how the run went through it. */
function stageView(
  run: RunRecord,
  stage: RunStage,
  place: number | undefined,
  askerName: string | undefined,
  schedule: string | undefined,
): StageView {
  const took = stage.ms !== null ? formatElapsed(stage.ms) : null;
  const unreached = stage.state === 'skipped' ? 'Not reached' : 'Next';
  const nothingToDo = foundNothingToDo(run);
  const agent = isAgentRunPreview(run.result) ? run.result : null;

  switch (stage.key) {
    case 'trigger': {
      const { trigger } = run;
      const time = new Date(trigger.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const late = Date.parse(run.createdAt) - Date.parse(trigger.at);
      if (trigger.kind === 'cron') {
        return {
          icon: Clock,
          kicker: trigger.catchUp ? 'Schedule, caught up' : 'Schedule',
          title: schedule ?? 'On schedule',
          outcome: trigger.catchUp && late >= 1000 ? `Due ${time} · ran ${formatElapsed(late)} late` : `Fired ${time}`,
        };
      }
      if (trigger.kind === 'event') {
        return { icon: Inbox, kicker: 'Inbox event', title: agent?.item?.label ?? 'An item arrived', outcome: `Seen ${time}` };
      }
      if (trigger.by === 'agent') {
        return { icon: Bot, kicker: 'Agent request', title: askerName ? `Asked by ${askerName}` : 'Asked by an agent', outcome: `Asked ${time}` };
      }
      return { icon: Play, kicker: 'Run now', title: 'Run by you', outcome: `Started ${time}` };
    }
    case 'preview':
      return {
        icon: ScanSearch,
        kicker: 'Preview',
        title: 'What it would do',
        outcome:
          stage.state === 'running'
            ? 'Looking…'
            : stage.state === 'failed'
              ? `Failed${took ? ` after ${took}` : ''}`
              : stage.state === 'passed'
                ? nothingToDo
                  ? 'Nothing to do'
                  : run.mode === 'notify'
                    ? 'Previewed'
                    : 'Ready for you'
                : unreached,
      };
    case 'approval':
      return {
        icon: Hand,
        kicker: 'Approval',
        title: 'Your approval',
        outcome:
          stage.state === 'waiting'
            ? `Waiting for you${took ? ` · ${took}` : ''}`
            : stage.state === 'passed'
              ? took
                ? `Approved after ${took}`
                : 'Approved'
              : stage.state === 'stopped'
                ? `Dismissed${took ? ` after ${took}` : ''}`
                : stage.state === 'failed'
                  ? 'Approved, but not run'
                  : nothingToDo
                    ? 'Nothing to approve'
                    : unreached,
      };
    case 'queue':
      return {
        icon: Hourglass,
        kicker: 'Queue',
        title: 'A free agent slot',
        outcome:
          stage.state === 'queued'
            ? `${place !== undefined ? `${place} in line` : 'In line'}${took ? ` · ${took}` : ''}`
            : stage.state === 'passed'
              ? took === null
                ? 'Started'
                : stage.ms! < 1000
                  ? 'Started at once'
                  : `Waited ${took}`
              : stage.state === 'stopped'
                ? 'Taken out of line'
                : stage.state === 'failed'
                  ? 'Could not start'
                  : unreached,
      };
    case 'run':
      return {
        icon: agent ? Bot : Wrench,
        kicker: agent ? 'Agent session' : 'Consola tool',
        title: agent ? agent.runs : <code>{run.actionName.split('#').pop()}</code>,
        outcome:
          stage.state === 'running'
            ? `Running${took ? ` · ${took}` : ''}`
            : stage.state === 'passed'
              ? `Completed${took ? ` in ${took}` : ''}`
              : stage.state === 'failed'
                ? `Failed${took ? ` after ${took}` : ''}`
                : nothingToDo
                  ? 'Not needed'
                  : unreached,
      };
    case 'notify':
      return {
        icon: Bell,
        kicker: 'Notify',
        title: 'Told you what it would do',
        outcome: stage.state === 'passed' ? 'Nothing started' : unreached,
      };
  }
}
