import { ChevronRight, CircleX, FileCode, ListTree, MessagesSquare } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { rangeWords } from '../domain/runFile';
import { AGENT_CONVERSATION_LATER_WORDS, NO_STEPS_WORDS } from '../domain/runMessages';
import type { RunDetail, StepSummary } from '../domain/runs';
import type { TracePlace, TraceView } from '../domain/runsRoute';
import { stepKindWords, stepLook } from '../domain/runWords';
import {
  agentFile,
  artifactNote,
  attemptsLine,
  bytesInWords,
  cleanOutput,
  commandFailed,
  commandResult,
  earlierCosts,
  failureIsExit,
  failureWords,
  limitWords,
  notRunReason,
  opensItself,
  outputTypeWords,
  outputValueWords,
  printedWords,
  rowFacts,
  runIsOver,
  skippedCondition,
  stepCounts,
  stepOutcome,
  stepSummary,
  stepTone,
  stepWorkedFor,
  turnLine,
} from '../domain/stepTrace';
import type { StepTone } from '../domain/stepTrace';
import { RunFileView } from './RunFileView';
import { revealElement } from './reveal';
import { StatusGlyph } from './RunStatusIcon';
import './StepTrace.css';

/**
 * An automation run's steps as the desktop traces them (`Automations/StepsRunView.tsx`): every
 * step in the file's order, each saying in a line what it did, and opening in place onto what it
 * was asked, what it is doing or did, and what it produced. A step that failed, runs or waits
 * opens by itself and stays open once it has, so what the person reads does not fold away as it
 * finishes; their own choice wins over that. A failed run says first where it broke, and that
 * step's name takes them to it.
 *
 * When the cell holds the file the run executed (`source`), Steps and File are two views of one
 * run, a tablist at the trace's head, and the address keeps which is shown and the step chosen
 * (`place`, written through `onPlace`). They are linked: "View in file" on a step shows its lines
 * and lights them once; a step's lines in the file choose it, and Show in steps takes the person
 * back to it there. An address that names a step arrives at it once, in either view.
 *
 * Everything a step carries is someone's text (a prompt, a command, what it printed, an error):
 * it is shown as text, and its output is cleaned of the terminal's codes (`cleanOutput`).
 */
export function StepTrace({
  detail,
  now,
  place,
  onPlace,
  nested = false,
}: {
  detail: RunDetail;
  now: number;
  place: TracePlace;
  onPlace: (place: TracePlace) => void;
  /** Inside another page's part (a request's automations): its heading a level down. */
  nested?: boolean;
}) {
  const { run, steps, source } = detail;
  const Heading = nested ? 'h3' : 'h2';
  const ids = useId();
  const over = runIsOver(run.phase);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const view: TraceView = source ? place.view : 'steps';
  const selected = steps.some((step) => step.id === place.step) ? place.step : null;
  const fileSteps = useMemo(
    () => steps.map((step) => ({ id: step.id, range: step.definition?.range ?? null })),
    [steps],
  );
  const [fileReveal, setFileReveal] = useState<{ step: string; seq: number } | null>(null);
  const reveals = useRef(0);

  // The person's own choice per step wins; else a step is open once it has failed, run or waited.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const arriving = steps
    .filter((step) => opensItself(step) && !opened.has(step.id))
    .map((step) => step.id);
  if (arriving.length > 0) setOpened(new Set([...opened, ...arriving]));
  const isOpen = (stepId: string) =>
    chosen[stepId] ?? (opened.has(stepId) || arriving.includes(stepId));
  const allOpen = steps.length > 0 && steps.every((step) => isOpen(step.id));

  /** Opens a step in the steps, scrolls to it and lights it once. */
  const showStep = (stepId: string) => {
    onPlace({ view: 'steps', step: stepId });
    setChosen((current) => ({ ...current, [stepId]: true }));
    requestAnimationFrame(() => revealElement(rows.current.get(stepId)));
  };

  /** Shows a step's lines in the file, scrolled to and lit once. */
  const viewInFile = (stepId: string) => {
    onPlace({ view: 'file', step: stepId });
    setFileReveal({ step: stepId, seq: ++reveals.current });
  };

  // An address that names a step arrives at it once, in the view it names.
  const arrived = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the run first shows; the step and view are the address's at that moment.
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    if (!selected) return;
    if (view === 'file') setFileReveal({ step: selected, seq: ++reveals.current });
    else showStep(selected);
  }, []);

  const tabs: { view: TraceView; label: string; icon: ReactNode }[] = [
    { view: 'steps', label: 'Steps', icon: <ListTree size={13} aria-hidden="true" /> },
    { view: 'file', label: 'File', icon: <FileCode size={13} aria-hidden="true" /> },
  ];
  const tabId = (of: TraceView) => `${ids}-tab-${of}`;
  const panelId = (of: TraceView) => `${ids}-panel-${of}`;
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: TraceView = view === 'steps' ? 'file' : 'steps';
    onPlace({ view: next, step: selected });
    requestAnimationFrame(() => document.getElementById(tabId(next))?.focus());
  };

  const list =
    steps.length === 0 ? (
      <p className="trace-quiet">{NO_STEPS_WORDS}</p>
    ) : (
      <ol className="trace-list" aria-label="Steps of this run">
        {steps.map((step) => (
          <StepRow
            key={step.id}
            rowRef={(element) => {
              if (element) rows.current.set(step.id, element);
              else rows.current.delete(step.id);
            }}
            detail={detail}
            step={step}
            now={now}
            open={isOpen(step.id)}
            onToggle={() => {
              const opening = !isOpen(step.id);
              setChosen((current) => ({ ...current, [step.id]: opening }));
              if (opening) onPlace({ view: 'steps', step: step.id });
            }}
            onViewInFile={source && step.definition?.range ? () => viewInFile(step.id) : null}
          />
        ))}
      </ol>
    );

  return (
    <>
      {run.phase === 'failed' && <FailureNote detail={detail} onShow={showStep} />}
      <section className="trace" aria-labelledby={`${ids}-steps`}>
        <div className="trace-head">
          <Heading id={`${ids}-steps`} className="trace-title">
            Steps
            {steps.length > 0 && <span className="trace-counts">{stepCounts(steps, over)}</span>}
          </Heading>
          <div className="trace-tools">
            {source && (
              <div className="trace-tabs" role="tablist" aria-label="Show the steps or the file">
                {tabs.map((tab) => (
                  <button
                    key={tab.view}
                    type="button"
                    role="tab"
                    id={tabId(tab.view)}
                    className="trace-tab"
                    aria-selected={view === tab.view}
                    // Only the view shown has its panel on the page.
                    aria-controls={view === tab.view ? panelId(tab.view) : undefined}
                    tabIndex={view === tab.view ? 0 : -1}
                    onKeyDown={onTabKey}
                    onClick={() => onPlace({ view: tab.view, step: selected })}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
            {view === 'steps' && steps.length > 1 && (
              <button
                type="button"
                className="trace-all"
                onClick={() =>
                  setChosen(Object.fromEntries(steps.map((step) => [step.id, !allOpen])))
                }
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
        </div>
        {!source ? (
          list
        ) : view === 'steps' ? (
          <div role="tabpanel" id={panelId('steps')} aria-labelledby={tabId('steps')}>
            {list}
          </div>
        ) : (
          <RunFileView
            id={panelId('file')}
            labelledBy={tabId('file')}
            source={source}
            steps={fileSteps}
            selected={selected}
            reveal={fileReveal}
            onSelect={(stepId) => onPlace({ view: 'file', step: stepId })}
            onShowInSteps={showStep}
          />
        )}
      </section>
    </>
  );
}

/**
 * One step of the trace: how it went and what it did in a line, opening onto all of it in place.
 * The row is the step's region, so what it did is never far from which step it was.
 */
function StepRow({
  rowRef,
  detail,
  step,
  now,
  open,
  onToggle,
  onViewInFile,
}: {
  rowRef: (element: HTMLLIElement | null) => void;
  detail: RunDetail;
  step: StepSummary;
  now: number;
  open: boolean;
  onToggle: () => void;
  /** Shows the step's lines in the run's file; null when its lines are not known. */
  onViewInFile: (() => void) | null;
}) {
  const bodyId = useId();
  const tone = stepTone(step.status, runIsOver(detail.run.phase));
  const look = stepLook(step.status);
  const ms = stepWorkedFor(step, now);
  const outcome = stepOutcome(step, tone, ms);
  const summary = stepSummary(step, { ...detail.run, steps: detail.steps });
  const ran = tone === 'passed' || tone === 'failed' || tone === 'running';
  const facts = ran ? rowFacts(step, now) : outcome;

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="trace-step"
      data-tone={tone}
      data-open={open || undefined}
    >
      <section aria-label={`Step ${step.id}`}>
        <button
          type="button"
          className="trace-row"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          aria-label={`${step.id}: ${outcome}`}
          onClick={onToggle}
        >
          <span className="run-status" data-look={tone === 'not-run' ? 'stopped' : look}>
            <StatusGlyph look={tone === 'not-run' ? 'stopped' : look} size={16} />
          </span>
          <span className="trace-main">
            <span className="trace-name">
              <span className="trace-id">{step.id}</span>
              <span className="trace-kind">{stepKindWords(step)}</span>
            </span>
            {summary && !open && (
              <span
                className="trace-summary"
                data-printed={step.kind === 'run' && tone === 'running' ? '' : undefined}
              >
                {summary}
              </span>
            )}
          </span>
          {facts && <span className="trace-facts">{facts}</span>}
          <ChevronRight size={14} className="trace-chevron" aria-hidden="true" />
        </button>
        {open && (
          <div id={bodyId} className="trace-body">
            <StepDetail detail={detail} step={step} tone={tone} />
            {onViewInFile && step.definition?.range && (
              <div className="trace-body-foot">
                <button type="button" className="trace-link" onClick={onViewInFile}>
                  <FileCode size={13} aria-hidden="true" />
                  View in file · {rangeWords(step.definition.range)}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </li>
  );
}

type Fact = { label: string; body: ReactNode };

/**
 * A step's trace, open: what it was asked (from the factory version the run executed), what it
 * is doing or did, what it produced, and, for an agent, where its conversation will show. Each
 * part shows only when it has something to say.
 */
function StepDetail({
  detail,
  step,
  tone,
}: {
  detail: RunDetail;
  step: StepSummary;
  tone: StepTone;
}) {
  const asked = askedFacts(step);
  const did = didFacts(detail, step, tone);
  const produced = producedFacts(step, tone);
  const ran = tone === 'passed' || tone === 'failed' || tone === 'running';
  return (
    <div className="trace-detail">
      <FactGroup title="Asked" facts={asked} />
      <FactGroup title={tone === 'running' ? 'Doing' : 'Did'} facts={did} />
      <FactGroup title="Produced" facts={produced} />
      {step.kind === 'agent' && ran && (
        <div className="trace-later">
          <MessagesSquare size={14} aria-hidden="true" />
          <p>{AGENT_CONVERSATION_LATER_WORDS}</p>
        </div>
      )}
    </div>
  );
}

/** A part of a step's trace: a quiet heading over its labelled facts; nothing when it has none. */
function FactGroup({ title, facts }: { title: string; facts: Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <div className="trace-group">
      <h3 className="trace-group-title">{title}</h3>
      <dl className="trace-facts-list">
        {facts.map((fact) => (
          <div key={fact.label} className="trace-fact">
            <dt>{fact.label}</dt>
            <dd>{fact.body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** What the step was asked, as the factory's file has it: never rendered, a template as written. */
function askedFacts(step: StepSummary): Fact[] {
  const definition = step.definition;
  const facts: Fact[] = [];
  const agent = definition?.agent ?? step.agent;
  if (definition?.kind === 'run' || (!definition && step.kind === 'run')) {
    if (definition?.run) {
      facts.push({ label: 'Command', body: <pre className="trace-code">{definition.run}</pre> });
    }
    if (definition && definition.env.length > 0) {
      facts.push({
        label: 'Env',
        body: (
          <ul className="trace-vars">
            {definition.env.map((entry) => (
              <li key={entry.name}>
                <span className="trace-var-name">
                  <code>{entry.name}</code>
                  <span className="trace-var-eq"> = </span>
                </span>
                <code className="trace-var-value">{entry.value}</code>
              </li>
            ))}
          </ul>
        ),
      });
    }
  } else if (definition) {
    if (definition.action) {
      facts.push({
        label: 'Action',
        body: (
          <p className="trace-text">
            The action <code className="trace-inline">{definition.action}</code>
          </p>
        ),
      });
    } else if (definition.prompt) {
      facts.push({ label: 'Prompt', body: <pre className="trace-quote">{definition.prompt}</pre> });
    }
  }
  if (agent) {
    facts.push({
      label: 'Agent',
      body: (
        <p className="trace-text">
          {agent} <span className="trace-note">{agentFile(agent)}</span>
        </p>
      ),
    });
  }
  if (!definition) return facts;
  if (definition.if) {
    const skippedOnIt = skippedCondition(step.skipped) !== null;
    facts.push({
      label: 'If',
      body: (
        <>
          <code className="trace-inline trace-block">{definition.if}</code>
          {skippedOnIt && <p className="trace-note">It was false, so the step was skipped.</p>}
        </>
      ),
    });
  }
  if (definition.outputs.length > 0) {
    facts.push({
      label: 'Sets',
      body: (
        <ul className="trace-list-plain">
          {definition.outputs.map((output) => (
            <li key={output.name}>
              <code className="trace-inline">{output.name}</code>{' '}
              <span className="trace-note">{outputTypeWords(output.type)}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (definition.artifacts.length > 0) {
    facts.push({
      label: 'Writes',
      body: (
        <ul className="trace-list-plain">
          {definition.artifacts.map((name) => (
            <li key={name}>
              <code className="trace-inline">{name}</code>
            </li>
          ))}
        </ul>
      ),
    });
  }
  const limits = [
    definition.maxTurns !== null ? `At most ${definition.maxTurns} turns` : null,
    definition.timeoutMs !== null ? `Stops after ${limitWords(definition.timeoutMs)}` : null,
  ].filter((limit): limit is string => limit !== null);
  if (limits.length > 0) {
    facts.push({ label: 'Limits', body: <p className="trace-text">{limits.join(' · ')}</p> });
  }
  facts.push({
    label: 'From',
    body: (
      <p className="trace-note">
        <code className="trace-inline">{definition.file}</code> · v{definition.version}
      </p>
    ),
  });
  return facts;
}

/** What the step is doing or did: its turns, or its command's result and output; its attempts. */
function didFacts(detail: RunDetail, step: StepSummary, tone: StepTone): Fact[] {
  const facts: Fact[] = [];
  const ran = tone === 'passed' || tone === 'failed' || tone === 'running';
  if (!ran) {
    facts.push(whyFact(detail, step, tone));
  } else if (step.kind === 'agent') {
    const turns = turnLine(step);
    if (turns) facts.push({ label: 'Turns', body: <p className="trace-text">{turns}</p> });
    else if (tone === 'running') {
      facts.push({ label: 'Turns', body: <p className="trace-text trace-quiet">Working…</p> });
    }
    if (step.model) {
      facts.push({ label: 'Model', body: <code className="trace-model">{step.model}</code> });
    }
    const denied = step.turn?.deniedTools ?? [];
    if (denied.length > 0) {
      facts.push({
        label: 'Denied',
        body: (
          <ul className="trace-tags">
            {denied.map((tool) => (
              <li key={tool}>
                <code className="trace-tag">{tool}</code>
              </li>
            ))}
          </ul>
        ),
      });
    }
    const earlier = earlierCosts(step);
    if (earlier) facts.push({ label: 'Earlier', body: <p className="trace-note">{earlier}</p> });
  } else {
    const result = commandResult(step);
    if (result) {
      facts.push({
        label: 'Result',
        body: (
          <p className="trace-text" data-tone={commandFailed(step.command) ? 'bad' : undefined}>
            {result}
          </p>
        ),
      });
    }
    facts.push(...outputFacts(step, tone === 'running'));
  }
  const attempts = attemptsLine(step);
  if (attempts) facts.push({ label: 'Attempts', body: <p className="trace-text">{attempts}</p> });
  return facts;
}

/** Why a step did not run, or what it waits for. */
function whyFact(detail: RunDetail, step: StepSummary, tone: StepTone): Fact {
  const text =
    tone === 'skipped'
      ? (step.skipped ?? 'It was skipped.')
      : tone === 'reported'
        ? 'A dry run reports what this step would do instead of running it.'
        : tone === 'waiting'
          ? step.status === 'queued'
            ? 'For its turn: it starts when the runner has room for it.'
            : 'It waits before it goes on.'
          : tone === 'pending'
            ? 'It starts once the steps before it are done.'
            : notRunReason(detail.run.status, detail.steps);
  return {
    label: tone === 'waiting' || tone === 'pending' ? 'Waits' : 'Why',
    body: <p className="trace-text">{text}</p>,
  };
}

/** What a command printed: the end of each stream, or what it amounted to when none was kept. */
function outputFacts(step: StepSummary, running: boolean): Fact[] {
  const output = step.output;
  const streams = (['stdout', 'stderr'] as const).filter((stream) => output?.[stream]);
  if (output && streams.length > 0) {
    return streams.map((stream, index) => ({
      label: stream,
      body: (
        <OutputLog
          text={output[stream]}
          stream={stream}
          live={running}
          cut={output.truncated && index === 0}
        />
      ),
    }));
  }
  const printed = printedWords(step.command);
  const said = running
    ? 'Nothing printed yet.'
    : printed === null || printed === 'nothing'
      ? 'It printed nothing.'
      : `It printed ${printed}; none of it reached the cloud.`;
  return [{ label: 'Output', body: <p className="trace-text trace-quiet">{said}</p> }];
}

/**
 * One stream of output, as plain text cleaned of the terminal's codes, kept scrolled to its end
 * as it grows while the person has not scrolled up to read.
 */
function OutputLog({
  text,
  stream,
  live,
  cut,
}: {
  text: string;
  stream: 'stdout' | 'stderr';
  live: boolean;
  /** More came before what the runner kept: the start of this is not the start of the output. */
  cut: boolean;
}) {
  // Cleaned of the terminal's codes, without the blank line a last newline would leave.
  const clean = useMemo(() => cleanOutput(text).replace(/\n+$/, ''), [text]);
  const box = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: what it follows is the text growing; the box is read through its ref.
  useLayoutEffect(() => {
    const element = box.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [clean]);
  return (
    <>
      {cut && <p className="trace-note">Earlier output cut: this is the end of what it printed.</p>}
      <pre
        ref={box}
        className="trace-log"
        data-stream={stream}
        onScroll={(event) => {
          const element = event.currentTarget;
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
        }}
      >
        {clean}
      </pre>
      {live && <p className="trace-note">As it runs, newest last.</p>}
    </>
  );
}

/** What the step produced: its error, the outputs it set, the documents it wrote. */
function producedFacts(step: StepSummary, tone: StepTone): Fact[] {
  const facts: Fact[] = [];
  if (tone === 'failed' && !(step.kind === 'run' && failureIsExit(step.error))) {
    facts.push({
      label: 'Error',
      body: (
        <p className="trace-text trace-error">{step.error ?? 'It failed without saying why.'}</p>
      ),
    });
  }
  const outputs = Object.entries(step.outputs ?? {});
  if (outputs.length > 0) {
    facts.push({
      label: 'Outputs',
      body: (
        <>
          <ul className="trace-vars">
            {outputs.map(([name, value]) => (
              <li key={name}>
                <span className="trace-var-name">
                  <code>{name}</code>
                  <span className="trace-var-eq"> = </span>
                </span>
                <code className="trace-var-value">{outputValueWords(value)}</code>
              </li>
            ))}
          </ul>
          <p className="trace-note">
            Later steps read {outputs.length === 1 ? 'it' : 'them'} as{' '}
            <code className="trace-inline">
              steps.{step.id}.{outputs.length === 1 ? outputs[0][0] : '<name>'}
            </code>
          </p>
        </>
      ),
    });
  }
  if (step.artifacts.length > 0) {
    facts.push({
      label: 'Artifacts',
      body: (
        <>
          <ul className="trace-list-plain">
            {step.artifacts.map((artifact) => {
              const note = artifactNote(artifact.name, step.kind);
              return (
                <li key={artifact.name}>
                  <code className="trace-inline">{artifact.name}</code>{' '}
                  <span className="trace-note">
                    {bytesInWords(artifact.bytes)}
                    {note ? ` · ${note}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="trace-note">Opening an artifact here comes later.</p>
        </>
      ),
    });
  }
  return facts;
}

/**
 * What went wrong, said once above the trace: the step the run failed at, whose name takes the
 * person to it, why in plain words, and what never ran because of it.
 */
function FailureNote({ detail, onShow }: { detail: RunDetail; onShow: (stepId: string) => void }) {
  const failed = detail.steps.find((step) => step.status === 'failed');
  const words = failureWords(failed ? failed.error : detail.run.error);
  const notRun = detail.steps
    .filter((step) => step.status === 'not-run' || step.status === 'pending')
    .map((step) => step.id);
  return (
    <div className="trace-failure" role="note">
      <CircleX size={16} aria-hidden="true" />
      <div className="trace-failure-body">
        <strong className="trace-failure-title">
          {failed ? (
            <>
              Failed at{' '}
              <button
                type="button"
                className="trace-failure-step"
                title={`Show ${failed.id}’s trace`}
                onClick={() => onShow(failed.id)}
              >
                {failed.id}
              </button>
            </>
          ) : (
            'Failed before its steps finished'
          )}
        </strong>
        <p className="trace-failure-text">{words.text}</p>
        {words.quote && <p className="trace-failure-quote">{words.quote}</p>}
        {notRun.length > 0 && (
          <p className="trace-failure-text">
            Because of this, <Ids ids={notRun} /> did not run.
          </p>
        )}
      </div>
    </div>
  );
}

/** Step ids in a sentence, as code, listed as a person lists them: `a`, `a and b`, `a, b and c`. */
function Ids({ ids }: { ids: string[] }) {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index === 0 ? '' : index === ids.length - 1 ? ' and ' : ', '}
          <code className="trace-inline">{id}</code>
        </span>
      ))}
    </>
  );
}
