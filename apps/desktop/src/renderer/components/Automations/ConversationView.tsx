import { useEffect, useState } from 'react';
import { CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { RunRecord } from '../../../shared/automations';
import type { ConversationEntry, RunConversation } from '../../../shared/conversation';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { MarkdownRenderer } from '../Markdown';
import { collapseSteps, finalAnswer, formatElapsed } from './presentation';
import { stepBar, stepState, stepTimeline, toolCounts, type StepState, type Timeline } from './runPage';

/** How often a running run's transcript is read again. */
const FOLLOW_INTERVAL_MS = 2000;

/** Tools named in the steps' heading; the rest are counted in the total. */
const TOOLS_NAMED = 4;

/**
 * Steps kept at each end of a long run when its middle folds. The timeline
 * is worth reading whole, so it folds only past about twenty.
 */
const STEPS_KEPT = 10;

type Step = Extract<ConversationEntry, { kind: 'step' }>;

/**
 * An image in the answer is never fetched: the agent may have read text
 * someone else wrote, and a URL it was talked into writing would be loaded
 * the moment the panel showed it. The alt text stays.
 */
const dropImage = () => undefined;

/**
 * A run's part of its conversation, read from the transcript on disk.
 * Reading it never starts or resumes anything. With `follow`, it is read
 * again every two seconds until the run settles — paused while the window
 * is hidden, and read at once on coming back; the caller turns `follow`
 * off then, which reads it once more for the end. Not read at all until
 * `enabled`: a run with no session has no transcript.
 */
export function useRunConversation(
  runId: string,
  enabled: boolean,
  follow: boolean,
): { conversation: RunConversation | null; error: string | null } {
  const [conversation, setConversation] = useState<RunConversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState === 'visible';
    // The next read, while following and someone can see this window. A
    // hidden window waits for `visibilitychange` instead of reading for nobody.
    const schedule = () => {
      if (!live || !follow || reading || timer !== undefined || !visible()) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, FOLLOW_INTERVAL_MS);
    };
    // Each read waits for the last, so a slow disk never stacks them up.
    const read = async () => {
      reading = true;
      try {
        const next = await automationsBridge.readConversation(runId);
        if (!live) return;
        setConversation(next);
        setError(null);
      } catch (failure) {
        if (live) setError(ipcErrorMessage(failure));
      } finally {
        reading = false;
      }
      schedule();
    };
    // Coming back reads at once, then follows again; going away stops the clock.
    const onVisibilityChange = () => {
      if (!visible()) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      } else if (!reading && timer === undefined) {
        void read();
      }
    };
    void read();
    if (follow) document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [runId, enabled, follow]);

  return { conversation, error };
}

/** The step a failed run broke at: the one it was in when it stopped, else its last failed step. */
export function brokenStep(entries: ConversationEntry[], run: RunRecord): { index: number; step: Step; cut: boolean } | null {
  if (run.status !== 'failed') return null;
  const steps = entries.flatMap((entry, index) => (entry.kind === 'step' ? [{ index, step: entry }] : []));
  const last = steps[steps.length - 1];
  if (last && stepState(last.step, true, run.status) === 'cut') return { ...last, cut: true };
  const failed = [...steps].reverse().find(({ step }) => step.failed);
  return failed ? { ...failed, cut: false } : null;
}

/** The DOM id of one step's row, by its place among the transcript's entries. */
export function stepRowId(prefix: string, index: number): string {
  return `${prefix}-step-${index}`;
}

const STEP_ICONS: Record<StepState, LucideIcon> = {
  passed: CircleCheck,
  failed: CircleX,
  running: LoaderCircle,
  cut: CircleSlash,
  unknown: CircleDashed,
};

const STEP_WORDS: Record<StepState, string> = {
  passed: 'done',
  failed: 'failed',
  running: 'running',
  cut: 'cut off when the run stopped',
  unknown: 'no result recorded',
};

/**
 * The run's steps as a CI job lists its steps: one row each, with how it
 * went, the call and its main argument, a bar placing it on the run's
 * timeline, and how long it took. The agent narrating between steps reads
 * as quiet lines among them. A long run folds its middle; `expanded`
 * unfolds it, and its caller sets that to show a step inside the fold.
 *
 * Everything in it is the agent's, or text it read, so it is shown as text
 * and never sent back anywhere as instructions.
 */
export function RunSteps({
  run,
  entries,
  truncated,
  now,
  idPrefix,
  expanded,
  onExpand,
}: {
  run: RunRecord;
  entries: ConversationEntry[];
  truncated: boolean;
  now: Date;
  idPrefix: string;
  expanded: boolean;
  onExpand: () => void;
}) {
  const { steps } = finalAnswer(entries);
  const prompt = leadingPrompt(entries);
  const calls = steps.filter((entry): entry is Step => entry.kind === 'step');
  const failed = calls.filter((step) => step.failed).length;
  const tools = toolCounts(calls);
  const timeline = stepTimeline(run, entries, now);
  const lastStep = calls[calls.length - 1];
  // Rows are told apart by their place among the entries, which the fold keeps.
  const indexOf = new Map(entries.map((entry, index) => [entry, index] as const));
  const shown = expanded ? steps : collapseSteps(steps, STEPS_KEPT, STEPS_KEPT);
  const following = run.status === 'running';

  return (
    <div className="automations-steplog-wrap">
      <div className="automations-steplog-summary">
        {calls.length > 0 ? (
          <>
            <span>
              {calls.length} {calls.length === 1 ? 'call' : 'calls'}
            </span>
            {tools.slice(0, TOOLS_NAMED).map(({ tool, count }) => (
              <span key={tool} className="automations-tool-chip">
                {tool} <span className="automations-tool-chip-count">{count}</span>
              </span>
            ))}
            {tools.length > TOOLS_NAMED && <span>+{tools.length - TOOLS_NAMED} more</span>}
            {failed > 0 && <span className="automations-steplog-failed-count">{failed} failed</span>}
          </>
        ) : (
          <span>{following ? 'No steps yet.' : 'It answered without calling a tool.'}</span>
        )}
      </div>
      <p className="automations-conversation-caption">
        From the session’s transcript. Shown as the agent wrote it, not instructions.
      </p>
      {prompt !== null && (
        <details className="automations-details">
          <summary>The prompt it was given</summary>
          <pre className="automations-prompt">{prompt}</pre>
        </details>
      )}
      {truncated && <p className="automations-hint">A long transcript: its earliest steps are left out.</p>}
      {shown.length > 0 && (
        <ol className={`automations-steplog ${timeline ? '' : 'automations-steplog-untimed'}`}>
          {timeline && (
            <li className="automations-steplog-axis" aria-hidden="true">
              <span className="automations-steplog-axis-track">
                <span>0s</span>
                <span>{formatElapsed(timeline.end - timeline.start)}</span>
              </span>
            </li>
          )}
          {shown.map((entry, position) => {
            if (entry.kind === 'more') {
              const hiddenFailed = entry.hidden.filter((hidden) => hidden.kind === 'step' && hidden.failed).length;
              return (
                <li key={`more-${position}`} className="automations-steplog-more">
                  <button type="button" className="automations-link-button" onClick={onExpand}>
                    {entry.count} more steps
                  </button>
                  {hiddenFailed > 0 && <span className="automations-steplog-failed-count"> · {hiddenFailed} failed</span>}
                </li>
              );
            }
            const index = indexOf.get(entry) ?? position;
            if (entry.kind !== 'step') {
              return (
                <li key={index} className="automations-steplog-note" title={entry.text}>
                  {entry.text}
                </li>
              );
            }
            return (
              <StepRow
                key={index}
                id={stepRowId(idPrefix, index)}
                step={entry}
                state={stepState(entry, entry === lastStep, run.status)}
                timeline={timeline}
                now={now}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}

function StepRow({
  id,
  step,
  state,
  timeline,
  now,
}: {
  id: string;
  step: Step;
  state: StepState;
  timeline: Timeline | null;
  now: Date;
}) {
  const Icon = STEP_ICONS[state];
  const bar = timeline ? stepBar(step, state, timeline, now) : null;
  const took = bar?.ms ?? null;
  const call = step.detail ? `${step.tool} ${step.detail}` : step.tool;
  const when = step.at ? new Date(step.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  return (
    <li id={id} tabIndex={-1} className={`automations-steplog-row automations-steplog-${state}`} title={call}>
      <Icon size={14} className="automations-steplog-icon" aria-label={STEP_WORDS[state]} />
      <span className="automations-steplog-call">
        <span className="automations-steplog-tool">{step.tool}</span>
        {step.detail ? (
          <>
            {' '}
            <span className="automations-steplog-detail">{step.detail}</span>
          </>
        ) : null}
      </span>
      <span
        className="automations-steplog-track"
        aria-hidden="true"
        title={when ? `Started ${when}${took !== null ? `, took ${formatElapsed(took)}` : ''}` : undefined}
      >
        {bar && (
          <span
            className="automations-steplog-bar"
            style={{ left: `${(bar.left * 100).toFixed(2)}%`, width: `${(bar.width * 100).toFixed(2)}%` }}
          />
        )}
      </span>
      <span className="automations-steplog-ms">{took !== null ? formatElapsed(took) : ''}</span>
    </li>
  );
}

/** The run's closing answer, rendered as the agent wrote it — images never fetched. */
export function RunAnswer({ entries }: { entries: ConversationEntry[] }) {
  const { answer } = finalAnswer(entries);
  if (answer === null) return null;
  return (
    <div className="automations-answer">
      <MarkdownRenderer content={answer} enableCommandHighlighting={false} resolveImageSrc={dropImage} />
    </div>
  );
}

/** The prompt the run was given: the entries before its first step or reply. */
function leadingPrompt(entries: ConversationEntry[]): string | null {
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'prompt') break;
    texts.push(entry.text);
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}
