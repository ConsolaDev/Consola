import { Bot, CircleSlash, ShieldCheck, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import {
  APPROVAL_TITLE,
  approverWords,
  DISMISS_QUESTION,
  messageForApproveAnswer,
  promptFirstLine,
  receiptWords,
  willRunAnything,
} from '../domain/runApproval';
import type { ApprovalDecision } from '../domain/runApproval';
import type { RunApproval } from '../domain/runs';
import type { WorkspaceMember } from '../domain/teams';
import type { MyWorkspace } from '../domain/workspace';
import { runsService } from '../services/runs';
import './ApprovalCard.css';

/**
 * A run that waits for approval, at the top of its pane (the design mock's approval card): why it
 * asks, in the API's words; what approving lets run, each command and each agent with what it is
 * asked; who may answer. Anyone on the factory's owning team gets Approve and Dismiss; Dismiss
 * asks once, in place. Everyone else reads the same card with no buttons.
 *
 * An answer is recorded by the API and acted on by the run's runner, so the card turns into its
 * receipt and the page reads the run again (`onAnswered`). Every refusal says why and reads the
 * run again too, so the card shows what the API holds now.
 */
export function ApprovalCard({
  approval,
  runId,
  workspace,
  meId,
  members,
  now,
  onAnswered,
}: {
  approval: RunApproval;
  runId: string;
  workspace: MyWorkspace;
  meId: string;
  members: WorkspaceMember[] | null;
  now: number;
  onAnswered: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState<ApprovalDecision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The answer given here, shown at once, and drawn as it lands: the API's own comes with the next read.
  const [given, setGiven] = useState<RunApproval['answer']>(null);
  const answer = given ?? approval.answer;

  const send = async (decision: ApprovalDecision) => {
    setSending(decision);
    setFailure(null);
    const result = await runsService.approveRun(workspace, runId, {
      decision,
      version: approval.version,
    });
    setSending(null);
    setAsking(false);
    if (result.kind === 'answered') setGiven(result.approval.answer);
    else setFailure(messageForApproveAnswer(result, approval));
    onAnswered();
  };

  if (answer) {
    const approved = answer.decision === 'approved';
    return (
      <div className="approval-receipt" data-decision={answer.decision} role="status">
        {approved ? (
          <svg
            className="approval-check"
            viewBox="0 0 18 18"
            aria-hidden="true"
            data-drawn={given ? '' : undefined}
          >
            <circle cx="9" cy="9" r="9" />
            <path d="m5.2 9.3 2.6 2.5 5-5.4" />
          </svg>
        ) : (
          <CircleSlash size={16} aria-hidden="true" />
        )}
        <p>{receiptWords(answer, meId, members, now)}</p>
        {failure && (
          <p className="approval-failure" role="alert">
            {failure}
          </p>
        )}
      </div>
    );
  }

  const busy = sending !== null;
  return (
    <section className="approval-card" aria-labelledby={`approval-${runId}`}>
      <div className="approval-head">
        <ShieldCheck size={16} aria-hidden="true" />
        <div>
          <h2 id={`approval-${runId}`} className="approval-title">
            {APPROVAL_TITLE}
          </h2>
          <p className="approval-reason">{approval.reason}</p>
        </div>
      </div>

      {willRunAnything(approval.will) && (
        <div className="approval-part">
          <h3 className="approval-part-title">Will run</h3>
          <ul className="approval-will">
            {approval.will.commands.map((command) => (
              <li key={`run ${command.step}`}>
                <SquareTerminal size={13} aria-hidden="true" />
                <span className="approval-will-text">
                  <span className="approval-step">{command.step}</span>
                  <code className="approval-command">{command.command}</code>
                </span>
              </li>
            ))}
            {approval.will.agents.map((agent) => {
              const asked = promptFirstLine(agent.prompt);
              return (
                <li key={`agent ${agent.step}`}>
                  <Bot size={13} aria-hidden="true" />
                  <span className="approval-will-text">
                    <span className="approval-step">{agent.step}</span>
                    <span>
                      {agent.agent ? `Agent ${agent.agent}` : 'An agent'}
                      {asked && <span className="approval-asked">: {asked}</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="approval-actions">
        {failure && (
          <p className="approval-failure" role="alert">
            {failure}
          </p>
        )}
        {asking ? (
          <fieldset className="approval-ask">
            <legend className="sr-only">Dismiss this run</legend>
            <p>{DISMISS_QUESTION}</p>
            <div className="approval-buttons">
              <button
                type="button"
                className="button"
                data-tone="danger"
                disabled={busy}
                onClick={() => void send('dismiss')}
              >
                {sending === 'dismiss' ? 'Dismissing…' : 'Dismiss run'}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                // The question replaces the button just pressed: the keyboard lands on the safe answer.
                autoFocus
                onClick={() => setAsking(false)}
              >
                Keep it
              </button>
            </div>
          </fieldset>
        ) : (
          <>
            <p className="approval-who">{approverWords(approval)}</p>
            {approval.mayAnswer && (
              <div className="approval-buttons">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => void send('approve')}
                >
                  {sending === 'approve' ? 'Approving…' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setAsking(true)}
                >
                  Dismiss
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
