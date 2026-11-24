import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  RunDefinition,
  StepDetail as StepDetailData,
  StepRun,
} from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { callHead, RESULT_FOLD_LINES, resultView, sentArgumentLine } from './callWords';
import { formatBytes } from './stepDetail';

type UsesDefinition = Extract<StepDetailData['step'], { kind: 'uses' }>;

/** One labelled fact of a step's trace, as `StepDetailView` draws its own. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="automations-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A `uses:` step's trace, from its attempt's folder: the tool and how it was
 * reached (or, under a dry run, that it would have been called), every
 * argument as written and as sent with its trust, what came back, and its
 * server's stderr. A call that recorded no `call.json` (it failed before
 * writing it) shows its call as the run's definition holds it.
 *
 * Every value is shown as text, never interpreted; what is here was masked
 * by the engine before it was written.
 */
export function CallDetail({
  step,
  detail,
  loaded,
}: {
  step: StepRun;
  detail: StepDetailData | null;
  loaded: boolean;
}) {
  const call = detail?.call;
  const head = callHead(call, step);
  const definition = detail?.step.kind === 'uses' ? detail.step : undefined;
  const running = step.status === 'running';

  if (!call) {
    if (definition) return <WouldCall definition={definition} />;
    return loaded ? (
      <Fact label="Tool">
        <p className="automations-fact-text automations-fact-quiet">Its call was not recorded.</p>
      </Fact>
    ) : null;
  }

  return (
    <>
      {head.heading && (
        <div className="automations-trace-note">
          <h4 className="automations-trace-note-title">{head.heading}</h4>
        </div>
      )}
      <Fact label="Tool">
        <p className="automations-fact-text">
          <code>
            {call.server}#{call.tool}
          </code>
        </p>
        {head.reached && <p className="automations-fact-note">{head.reached}</p>}
        {head.survivors && (
          <p className="automations-fact-text automations-fact-bad">{head.survivors}</p>
        )}
      </Fact>
      {call.arguments.length > 0 && (
        <Fact label="Arguments">
          <ul className="automations-call-args">
            {call.arguments.map((argument) => (
              <SentArgument key={argument.name} line={sentArgumentLine(argument)} />
            ))}
          </ul>
        </Fact>
      )}
      {!head.heading && (
        <ResultFact detail={detail} running={running} intent={step.call?.intentAt !== undefined} />
      )}
      {detail?.serverLog?.text && (
        <Fact label="Server log">
          <pre className="automations-prompt automations-fact-pre automations-log automations-log-stderr">
            {detail.serverLog.text}
          </pre>
          {detail.serverLog.truncated && (
            <p className="automations-fact-note">Showing the end of the log.</p>
          )}
        </Fact>
      )}
    </>
  );
}

/** One argument as sent: a short value inline, a long one folded between its name and its trust. */
function SentArgument({ line }: { line: ReturnType<typeof sentArgumentLine> }) {
  if (!line.long) return <li className="automations-call-arg">{line.line}</li>;
  return (
    <li className="automations-call-arg">
      {line.head}
      <details className="automations-details">
        <summary>Show value</summary>
        <pre className="automations-prompt automations-var-block">{line.value}</pre>
      </details>{' '}
      {line.label}
    </li>
  );
}

/** What came back: its text, folded past 40 lines behind Show all; nothing before an answer. */
function ResultFact({
  detail,
  running,
  intent,
}: {
  detail: StepDetailData | null;
  running: boolean;
  intent: boolean;
}) {
  const [all, setAll] = useState(false);
  const view = resultView(detail?.result);
  if (view.state === 'none') {
    if (!running || !intent) return null;
    return (
      <Fact label="Result">
        <p className="automations-fact-text automations-fact-quiet">Waiting for its answer…</p>
      </Fact>
    );
  }
  const lines = view.text.split('\n');
  const folded = !all && lines.length > RESULT_FOLD_LINES;
  const text = folded ? lines.slice(0, RESULT_FOLD_LINES).join('\n') : view.text;
  return (
    <Fact label="Result">
      <pre
        className={`automations-prompt automations-fact-pre ${view.state === 'error' ? 'automations-fact-bad' : ''}`}
      >
        {text}
      </pre>
      {folded && (
        <p className="automations-fact-note">
          Showing the first {RESULT_FOLD_LINES} lines.{' '}
          <button type="button" className="automations-link-button" onClick={() => setAll(true)}>
            Show all
          </button>
        </p>
      )}
      {view.state === 'cut' && detail?.result && (
        <p className="automations-fact-note">
          Its result was {formatBytes(detail.result.bytes)}; Consola kept the first 1 MB.
        </p>
      )}
    </Fact>
  );
}

/** A literal argument as the file wrote it: text as it is, anything else as its JSON. */
function writtenText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

/**
 * What a call that recorded nothing would have called, as the run's
 * definition holds it: its tool and its `with:` exactly as written, no
 * template filled.
 */
export function WouldCall({ definition }: { definition: UsesDefinition }) {
  const written = Object.entries(definition.with);
  return (
    <>
      <Fact label="Would call">
        <p className="automations-fact-text">
          <code>{definition.uses}</code>
        </p>
      </Fact>
      {written.length > 0 && (
        <Fact label="with">
          <ul className="automations-call-args">
            {written.map(([name, template]) => (
              <li key={name} className="automations-call-arg">
                {`\`${name}\` = ${writtenText(template)}`}
              </li>
            ))}
          </ul>
        </Fact>
      )}
    </>
  );
}

/**
 * Each call's `<server>#<tool>` by step id, from the run's own definition,
 * read once per run and only when the run has a call: what the trace rows'
 * lines name. Empty until it is read, and when it cannot be.
 */
export function useCallRefs(runId: string, hasCalls: boolean): Readonly<Record<string, string>> {
  const [refs, setRefs] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    setRefs({});
    if (!hasCalls) return;
    let live = true;
    automationsBridge.getRunDefinition(runId).then(
      (definition: RunDefinition | null) => {
        if (!live || !definition?.calls) return;
        setRefs(
          Object.fromEntries(Object.entries(definition.calls).map(([id, view]) => [id, view.ref])),
        );
      },
      // The rows then read as a command's do; the step's own detail still names its tool.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [runId, hasCalls]);
  return refs;
}
