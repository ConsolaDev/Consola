import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Bell,
  Bot,
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileCode,
  Hand,
  Inbox,
  LoaderCircle,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { AutomationView, RunListEntry } from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { approvalStep, formatCountdown, formatDueAt, formatDuration, formatTime, yamlTokens } from './presentation';

type NodeState = 'due' | 'waiting' | 'running' | 'queued' | 'passed' | 'preview';

/**
 * An automation as the pipeline it is, drawn the way n8n and GitHub Actions
 * draw theirs: what fires it, the step a person stands in when there is
 * one, and what it runs, joined left to right (top to bottom when narrow).
 *
 * The nodes carry what is happening now, and only that: the countdown to
 * the next run, a run waiting at the approval step, one working in the
 * target. How past runs went is the lead's and the run list's to say.
 */
export function PipelineGraph({
  automation,
  runs,
  now,
  place,
  onOpenRun,
  draft = false,
}: {
  automation: AutomationView;
  /** What history keeps for it, newest first. */
  runs: RunListEntry[];
  now: Date;
  place: (runId: string) => number | undefined;
  onOpenRun: (runId: string) => void;
  /** Not in factory.yml yet (a template): its trigger says what would happen once added. */
  draft?: boolean;
}) {
  const step = approvalStep(automation, draft);
  const waiting = runs.find((run) => run.status === 'needs-approval');
  const running = runs.find((run) => run.status === 'running');
  const queued = runs.find((run) => run.status === 'queued');
  const countdown = automation.nextRunAt ? formatCountdown(automation.nextRunAt, now) : null;
  const due = !automation.problem && countdown === 'due now';
  // Once a run is working, the steps it came through are lit: the path it took.
  const targetState: NodeState | undefined = running ? 'running' : queued ? 'queued' : step?.kind === 'notify' ? 'preview' : undefined;
  const pathLit = targetState === 'running' || targetState === 'queued';

  const TriggerIcon: LucideIcon = automation.onEvent ? Inbox : automation.schedule ? Clock : Zap;
  const trigger = (
    <PipelineNode
      key="trigger"
      state={due ? 'due' : undefined}
      icon={TriggerIcon}
      kicker={automation.onEvent ? 'Inbox event' : automation.schedule ? 'Schedule' : 'Trigger'}
      title={automation.trigger}
      code={automation.schedule}
    >
      {draft ? (
        automation.onEvent ? (
          'Checked on each Inbox refresh, once added'
        ) : automation.nextRunAt && Date.parse(automation.nextRunAt) > now.getTime() ? (
          <span title={formatTime(automation.nextRunAt)}>
            First run <span className="automations-node-quiet">· {formatDueAt(automation.nextRunAt, now)}</span>
          </span>
        ) : (
          'On its schedule, once added'
        )
      ) : automation.problem ? (
        'Not scheduled while it has a problem'
      ) : automation.onEvent ? (
        'Checked on each Inbox refresh'
      ) : automation.nextRunAt && countdown ? (
        <span title={formatTime(automation.nextRunAt)}>
          {due ? 'Due now' : `Next ${countdown}`}
          <span className="automations-node-quiet"> · {formatDueAt(automation.nextRunAt, now)}</span>
        </span>
      ) : (
        'Not scheduled'
      )}
    </PipelineNode>
  );

  const gate = step && (
    <PipelineNode
      key="gate"
      state={step.kind === 'approve' && waiting ? 'waiting' : step.kind === 'approve' && pathLit ? 'passed' : undefined}
      icon={step.kind === 'approve' ? Hand : Bell}
      kicker={step.kind === 'approve' ? 'Approval' : 'Notify'}
      title={step.title}
    >
      {step.kind === 'approve' && waiting ? (
        <button type="button" className="automations-node-action" onClick={() => onOpenRun(waiting.id)}>
          Waiting for you · Review
          <ArrowRight size={12} aria-hidden="true" />
        </button>
      ) : (
        step.detail
      )}
    </PipelineNode>
  );

  const isAgent = automation.kind === 'agent';
  const target = (
    <PipelineNode
      key="target"
      state={targetState}
      icon={isAgent ? Bot : Wrench}
      kicker={isAgent ? 'Agent session' : 'Consola tool'}
      title={isAgent ? automation.runs : <code>{automation.target.split('#').pop()}</code>}
    >
      {running ? (
        <button type="button" className="automations-node-action" onClick={() => onOpenRun(running.id)}>
          <LoaderCircle size={12} className="automations-spin" aria-hidden="true" />
          Running · {formatDuration(running, now) ?? '0s'}
          <ArrowRight size={12} aria-hidden="true" />
        </button>
      ) : queued ? (
        <button type="button" className="automations-node-action" onClick={() => onOpenRun(queued.id)}>
          Queued{place(queued.id) !== undefined ? ` · ${place(queued.id)} in line` : ''}
          <ArrowRight size={12} aria-hidden="true" />
        </button>
      ) : step?.kind === 'notify' ? (
        'Previews only'
      ) : isAgent ? (
        'Read-only, in a session of its own'
      ) : (
        'Runs inside Consola, no session'
      )}
    </PipelineNode>
  );

  // Told about a preview, rather than asked before a run: the step comes after.
  const nodes = step?.kind === 'notify' ? [trigger, target, gate] : [trigger, gate, target];
  return (
    <ol className={`automations-pipeline ${automation.problem ? 'automations-pipeline-paused' : ''}`} aria-label="Pipeline">
      {nodes}
    </ol>
  );
}

function PipelineNode({
  state,
  icon: Icon,
  kicker,
  title,
  code,
  children,
}: {
  state?: NodeState;
  icon: LucideIcon;
  kicker: string;
  title: ReactNode;
  code?: string;
  children: ReactNode;
}) {
  return (
    <li className={`automations-node ${state ? `automations-node-${state}` : ''}`}>
      <div className="automations-node-kicker">
        <Icon size={13} aria-hidden="true" />
        {kicker}
      </div>
      <div className="automations-node-title">{title}</div>
      {code && <code className="automations-node-code">{code}</code>}
      <div className="automations-node-foot">{children}</div>
    </li>
  );
}

/**
 * The entry exactly as factory.yml has it, numbered from where it starts in
 * the file, as GitHub shows a workflow file. Read again whenever the
 * automation changes, so an edit in the person's editor shows here. Shading
 * is presentation only; the text is the file's.
 */
export function EntrySource({
  workspaceId,
  automation,
  opening,
  onOpenFile,
}: {
  workspaceId: string;
  automation: AutomationView;
  opening: boolean;
  onOpenFile: () => void;
}) {
  const [entry, setEntry] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    automationsBridge.getEntry(workspaceId, automation.name).then(
      (text) => {
        if (!live) return;
        setEntry(text);
        setLoadError(null);
      },
      (failure: unknown) => {
        if (live) setLoadError(ipcErrorMessage(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, automation]);

  const note =
    loadError && entry === undefined
      ? loadError
      : entry === undefined
        ? 'Loading…'
        : entry === null
          ? 'factory.yml no longer has this entry as written.'
          : null;

  return (
    <EntryCode
      text={entry ?? null}
      note={note}
      firstLine={automation.line}
      tools={
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          disabled={opening}
          onClick={onOpenFile}
        >
          <ExternalLink size={12} aria-hidden="true" />
          Open in editor
        </button>
      }
    />
  );
}

/**
 * One factory.yml entry as code, with a copy button. Numbered from the line
 * it starts on in the file — or, for an entry that is not in the file yet
 * (`addition`), marked line by line as what adding it writes, as a diff
 * marks an addition.
 */
export function EntryCode({
  text,
  note = null,
  firstLine,
  addition = false,
  tools,
}: {
  text: string | null;
  /** Said in place of the code: loading, gone, failed. */
  note?: string | null;
  firstLine?: number;
  addition?: boolean;
  tools?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = () => {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    });
  };

  const lines = text ? yamlTokens(text.replace(/\n+$/, '')) : [];
  const first = firstLine ?? 1;
  const where = addition
    ? `+${lines.length} ${lines.length === 1 ? 'line' : 'lines'}, at the end`
    : firstLine !== undefined && lines.length > 0
      ? lines.length === 1
        ? `line ${first}`
        : `lines ${first}–${first + lines.length - 1}`
      : null;

  return (
    <div className={`automations-entry ${addition ? 'automations-entry-addition' : ''}`}>
      <div className="automations-entry-head">
        <FileCode size={13} aria-hidden="true" />
        <span className="automations-entry-file">factory.yml</span>
        {where && <span className="automations-entry-lines">{where}</span>}
        <span className="automations-entry-tools">
          <button
            type="button"
            className="automations-icon-button"
            aria-label={copied ? 'Copied' : 'Copy the entry'}
            title={copied ? 'Copied' : 'Copy the entry'}
            disabled={!text}
            onClick={copy}
          >
            {copied ? <Check size={13} className="automations-copied" /> : <Copy size={13} />}
          </button>
          {tools}
        </span>
      </div>
      {note !== null || !text ? (
        <p className="automations-hint automations-entry-note">{note}</p>
      ) : (
        <pre className="automations-entry-code">
          <code>
            {lines.map((tokens, index) => (
              <span key={index} className="automations-entry-line">
                <span className="automations-entry-num" aria-hidden="true">
                  {addition ? '+' : first + index}
                </span>
                {tokens.map((token, part) => (
                  <span key={part} className={`automations-yaml-${token.kind}`}>
                    {token.text}
                  </span>
                ))}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}
