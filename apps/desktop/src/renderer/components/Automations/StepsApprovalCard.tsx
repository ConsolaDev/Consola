import { useEffect, useState } from 'react';
import { Bot, Hand, KeyRound, Plug, Repeat, Terminal } from 'lucide-react';
import type { RunDefinition, RunDefinitionView } from '../../../shared/automations';
import { useSettings } from '../../contexts/SettingsContext';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { ITEM_TEXT_LINE } from './agentGrantWords';
import {
  approvalAgent,
  approvalNotes,
  approvalSkills,
  definitionRows,
  dryRunCommands,
  gateChoicesWords,
  loopFoot,
} from './approvalCard';
import { CallLines, ServerLines } from './CallLines';
import { stepKindLabel } from './callWords';
import { useIntent } from './parts';
import { SecretLines, useEntrySecrets } from './SecretLines';
import { WritesBlock } from './WritesBlock';

type Loaded =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'failed'; reason: string }
  | { state: 'ready'; definition: RunDefinitionView };

/** The copy for a definition the run folder no longer has. */
export const DEFINITION_GONE = "This run's definition is gone, so it cannot be shown or started.";

/** Text longer than this folds into a disclosure; all of it is there when opened. */
const FOLD_CHARS = 400;
const FOLD_LINES = 8;

/**
 * What a steps run waits on, in full: every step the person is about to allow,
 * exactly as the file wrote it. Prompts, bodies, commands, `env:` templates and
 * `if:` are text, never Markdown or HTML, and no template is filled: the
 * person approves `{{steps.review.verdict}}`, not what it would become.
 *
 * Reading the definition, and the step detail of a step whose agent names
 * skills (each `SKILL.md` as the run holds it: review M4), is all that
 * opening the card does. Start and Dismiss are the same approve and dismiss
 * intents the legacy card sends. Under the steps, the Secrets lines say
 * where each secret goes and where this Mac binds it; while a name is unbound
 * Start is Bind…, which opens Settings › Secrets.
 */
export function StepsApprovalCard({
  workspaceId,
  runId,
  itemType = null,
}: {
  /** The run's workspace, whose snapshot holds its secrets' bindings. */
  workspaceId: string;
  runId: string;
  /** What the run's item is, for the pull request note; null for a scheduled run. */
  itemType?: 'pr' | 'issue' | null;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const { busy, error, act } = useIntent();
  const { openSettings } = useSettings();

  useEffect(() => {
    let live = true;
    setLoaded({ state: 'loading' });
    automationsBridge.getRunDefinition(runId).then(
      (definition) => {
        if (live) setLoaded(definition ? { state: 'ready', definition } : { state: 'gone' });
      },
      (failure: unknown) => {
        if (live) setLoaded({ state: 'failed', reason: ipcErrorMessage(failure) });
      },
    );
    return () => {
      live = false;
    };
  }, [runId]);

  const ready = loaded.state === 'ready' ? loaded.definition : null;
  const dryRun = ready ? dryRunCommands(ready) : [];
  // Its places come from the snapshot's uses of this entry (review S1), the definition's at any version a run can start.
  const { unbound } = useEntrySecrets(workspaceId, ready?.automation.name ?? '');

  return (
    <div className="automations-approval" aria-label="What this run will do">
      {loaded.state === 'loading' && <p className="automations-hint">Loading…</p>}
      {loaded.state === 'gone' && <p className="automations-hint">{DEFINITION_GONE}</p>}
      {loaded.state === 'failed' && (
        <p className="automations-error" role="alert">
          {loaded.reason}
        </p>
      )}
      {ready && (
        <>
          <ol className="automations-approval-steps">
            {/* Record order: a loop's own row, then its steps set in under it. */}
            {definitionRows(ready.automation).map(({ step, depth }) =>
              step.kind === 'repeat' ? (
                <ApprovalLoop key={step.id} step={step} />
              ) : (
                <ApprovalStep
                  key={step.id}
                  runId={runId}
                  step={step}
                  action={ready.actions[step.id]}
                  definition={ready}
                  inner={depth === 1}
                />
              ),
            )}
          </ol>
          <WritesBlock view={ready} />
          {ready.flow.length > 0 && (
            <div className="automations-approval-flow" role="group" aria-label="How this run flows">
              {ready.flow.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
          {approvalNotes(ready, itemType).map((note) => (
            <p key={note} className="automations-hint">
              {note}
            </p>
          ))}
          {dryRun.length > 0 && (
            <p className="automations-hint">Also runs in a dry run: {dryRun.join(', ')}</p>
          )}
          {/* Each server its calls start or call, once: its definition is part of what is approved. */}
          <ServerLines
            calls={ready.automation.steps.flatMap((step) => {
              const call = step.kind === 'uses' ? ready.calls?.[step.id] : undefined;
              return call ? [call] : [];
            })}
          />
          <SecretLines
            workspaceId={workspaceId}
            automation={ready.automation.name}
            lineClassName="automations-hint"
          />
        </>
      )}
      <div className="automations-card-actions">
        {unbound ? (
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            onClick={() => openSettings('secrets')}
          >
            <KeyRound size={12} aria-hidden="true" />
            Bind…
          </button>
        ) : (
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            disabled={busy !== null || !ready}
            onClick={() => void act('approve', () => automationsBridge.approve(runId))}
          >
            {busy === 'approve' ? 'Starting…' : 'Start'}
          </button>
        )}
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          disabled={busy !== null}
          onClick={() => void act('dismiss', () => automationsBridge.dismiss(runId))}
        >
          Dismiss
        </button>
      </div>
      {error && (
        <p className="automations-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A loop's own row: its bound, its `until`, and how it ends when that is never met. */
function ApprovalLoop({
  step,
}: {
  step: Extract<RunDefinition['automation']['steps'][number], { kind: 'repeat' }>;
}) {
  const { onExhausted } = step;
  const exhausted =
    onExhausted === undefined || onExhausted === 'fail'
      ? 'fail'
      : onExhausted === 'continue'
        ? 'continue'
        : 'gate';
  return (
    <li className="automations-approval-step automations-approval-loop">
      <div className="automations-approval-head">
        <Repeat size={13} aria-hidden="true" />
        <span className="automations-approval-id">{step.id}</span>
        <span className="automations-meta">
          Loop, up to {step.max} rounds, {loopFoot(exhausted)}
        </span>
      </div>
      {step.if !== undefined && (
        <div className="automations-approval-field">
          <span className="automations-approval-label">if</span>
          <code className="automations-approval-code">{step.if}</code>
        </div>
      )}
      <div className="automations-approval-field">
        <span className="automations-approval-label">until</span>
        <code className="automations-approval-code">{step.until}</code>
      </div>
      {typeof onExhausted === 'object' && (
        <div className="automations-approval-field">
          <span className="automations-approval-label">asks</span>
          <span>{onExhausted.ask}</span>
        </div>
      )}
    </li>
  );
}

function ApprovalStep({
  runId,
  step,
  action,
  definition,
  inner = false,
}: {
  runId: string;
  step: Exclude<RunDefinition['automation']['steps'][number], { kind: 'repeat' }>;
  action: RunDefinition['actions'][string] | undefined;
  definition: RunDefinition;
  /** A step inside a loop: set in under the loop's row. */
  inner?: boolean;
}) {
  // A gate asks a person and runs nothing: never drawn as a command.
  const Icon =
    step.kind === 'agent'
      ? Bot
      : step.kind === 'gate'
        ? Hand
        : step.kind === 'uses'
          ? Plug
          : Terminal;
  // The agent it runs as, exactly as approved: who it is, then what this step asks.
  const agent = step.kind === 'agent' ? approvalAgent(definition, step.id) : null;
  const named = agent?.skills !== null && agent?.skills !== undefined;
  const skills = useRunSkills(runId, step.id, named);
  return (
    <li className={`automations-approval-step ${inner ? 'automations-approval-step-inner' : ''}`}>
      <div className="automations-approval-head">
        <Icon size={13} aria-hidden="true" />
        <span className="automations-approval-id">{step.id}</span>
        <span className="automations-meta">
          {step.kind === 'agent' ? (agent?.head ?? 'Agent, read-only') : stepKindLabel(step.kind)}
        </span>
      </div>
      {step.if !== undefined && (
        <div className="automations-approval-field">
          <span className="automations-approval-label">if</span>
          <code className="automations-approval-code">{step.if}</code>
        </div>
      )}
      {agent && (
        <>
          <div className="automations-approval-field">
            <span className="automations-approval-label">agent</span>
            <span>{agent.words}</span>
          </div>
          {agent.description !== undefined && (
            <p className="automations-approval-description">{agent.description}</p>
          )}
          {/* What its servers grant: a whole server brings its write tools with it. */}
          {agent.servers.map((line) => (
            <p key={line} className="automations-approval-description">
              {line}
            </p>
          ))}
          {agent.skills !== null && (
            <p className="automations-approval-description">{agent.skills}</p>
          )}
          {/* Each skill as the run holds it: approving accepts its bytes too (review M4). */}
          {skills && 'texts' in skills
            ? skills.texts.map(({ file, text }) => (
                <details key={file} className="automations-details">
                  <summary>{file}</summary>
                  <pre className="automations-prompt">{text}</pre>
                </details>
              ))
            : skills && <p className="automations-hint">{skills.problem}</p>}
          {agent.readsOthers && <p className="automations-hint">{ITEM_TEXT_LINE}</p>}
          <Folded label={agent.file} text={agent.body} />
        </>
      )}
      {step.kind === 'uses' ? (
        // The run's own snapshot of the call: what it sends, from where, with what trust.
        definition.calls?.[step.id] ? (
          <CallLines call={definition.calls[step.id]} outputs={Object.keys(step.outputs)} />
        ) : (
          <code className="automations-approval-code">{step.uses}</code>
        )
      ) : step.kind === 'agent' ? (
        step.action !== undefined ? (
          <>
            <div className="automations-approval-field">
              <span className="automations-approval-label">action</span>
              <span>{action?.name ?? step.action}</span>
            </div>
            {action ? (
              <Folded label="The action's body" text={action.body} />
            ) : (
              <p className="automations-hint">Its body was not kept.</p>
            )}
          </>
        ) : step.prompt !== undefined || !agent ? (
          <Folded label="The prompt it will send" text={step.prompt ?? ''} />
        ) : null
      ) : step.kind === 'gate' ? (
        <>
          <div className="automations-approval-field">
            <span className="automations-approval-label">asks</span>
            <span>{step.ask}</span>
          </div>
          <div className="automations-approval-field">
            <span className="automations-approval-label">answers</span>
            <span>{gateChoicesWords(step.choices)}</span>
          </div>
        </>
      ) : (
        <>
          <Folded label="The command" text={step.run} mono />
          {Object.entries(step.env).map(([name, template]) => (
            <div key={name} className="automations-approval-field">
              <span className="automations-approval-label">env</span>
              <code className="automations-approval-code">
                {name}={template}
              </code>
            </div>
          ))}
        </>
      )}
    </li>
  );
}

/** Plain text, line breaks kept; folded into a disclosure when long. Never rendered as Markdown or HTML. */
/**
 * A step's skills as the run's own copy holds them (`approvalSkills`), read
 * once its agent names any; null while there is nothing to show yet.
 */
function useRunSkills(
  runId: string,
  stepId: string,
  named: boolean,
): ReturnType<typeof approvalSkills> | null {
  const [skills, setSkills] = useState<ReturnType<typeof approvalSkills> | null>(null);
  useEffect(() => {
    if (!named) return;
    let live = true;
    automationsBridge.getStepDetail(runId, stepId).then(
      (detail) => {
        if (live) setSkills(approvalSkills(detail));
      },
      (failure: unknown) => {
        if (live) setSkills({ problem: ipcErrorMessage(failure) });
      },
    );
    return () => {
      live = false;
    };
  }, [runId, stepId, named]);
  return named ? skills : null;
}

function Folded({ label, text, mono = false }: { label: string; text: string; mono?: boolean }) {
  const body = (
    <pre className={`automations-prompt ${mono ? 'automations-approval-command' : ''}`}>{text}</pre>
  );
  if (text.length <= FOLD_CHARS && text.split('\n').length <= FOLD_LINES) return body;
  return (
    <details className="automations-details">
      <summary>{label}</summary>
      {body}
    </details>
  );
}
