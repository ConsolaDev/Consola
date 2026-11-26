import { Check, Copy, FileCode, ListTree } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { fileLines, fileVersionWords, holdsOthers, inRange, rangeWords } from '../domain/runFile';
import type { LineRange, RunSource } from '../domain/runs';
import { copyText } from '../services/clipboard';
import './RunFileView.css';

/** A step of the file: its id, and its lines when the API knows them. */
export type FileStep = { id: string; range: LineRange | null };

/**
 * The file behind an automation run, at the version the run executed: its lines shaded as YAML,
 * numbered, the automation's own lines whole and the rest of a `factory.yml` quieter. It is linked
 * to the steps: the chosen step's lines are lit, a click on a step's lines (or its name in the
 * head) chooses it, and Show in steps takes the person to it there. `reveal` scrolls to a step's
 * lines and lights them once, as "View in file" asks.
 *
 * The file is someone's text: it is shown as text, token by token, never as markup.
 */
export function RunFileView({
  id,
  labelledBy,
  source,
  steps,
  selected,
  reveal,
  onSelect,
  onShowInSteps,
}: {
  id: string;
  labelledBy: string;
  source: RunSource;
  steps: readonly FileStep[];
  selected: string | null;
  /** A step to scroll to and light once; a new `seq` asks again. */
  reveal: { step: string; seq: number } | null;
  onSelect: (step: string) => void;
  onShowInSteps: (step: string) => void;
}) {
  const lines = useMemo(() => fileLines(source, steps), [source, steps]);
  const others = holdsOthers(source);
  const lineRefs = useRef(new Map<number, HTMLSpanElement>());
  const [copied, setCopied] = useState<'copied' | 'refused' | null>(null);
  const chosen = steps.find((step) => step.id === selected && step.range) ?? null;
  const placed = steps.filter(
    (step): step is { id: string; range: LineRange } => step.range !== null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `seq` is what asks again; the lines are read through their refs.
  useEffect(() => {
    if (!reveal) return;
    const range = steps.find((step) => step.id === reveal.step)?.range;
    if (!range) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    lineRefs.current
      .get(range.start)
      ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    for (let line = range.start; line <= range.end; line++) {
      const element = lineRefs.current.get(line);
      if (!element) continue;
      element.removeAttribute('data-flash');
      void element.offsetWidth;
      element.setAttribute('data-flash', '');
      element.addEventListener('animationend', () => element.removeAttribute('data-flash'), {
        once: true,
      });
    }
  }, [reveal?.seq]);

  const copy = async () => {
    setCopied((await copyText(source.text)) ? 'copied' : 'refused');
  };

  /** A click on a step's lines chooses it, unless the person was selecting text to copy. */
  const choose = (event: MouseEvent<HTMLElement>) => {
    if (!window.getSelection()?.isCollapsed) return;
    const step = (event.target as HTMLElement).closest<HTMLElement>('[data-step]')?.dataset.step;
    if (step) onSelect(step);
  };

  return (
    <div id={id} className="file-view" role="tabpanel" aria-labelledby={labelledBy}>
      <div className="file-head">
        <FileCode size={14} aria-hidden="true" />
        <span className="file-path">{source.path}</span>
        <span
          className="file-version"
          data-older={source.latestVersion > source.version || undefined}
        >
          {fileVersionWords(source.version, source.latestVersion)}
        </span>
        {others && <span className="file-own">This automation is {rangeWords(source.range)}</span>}
        <span className="file-tools">
          {chosen && (
            <button type="button" className="file-tool" onClick={() => onShowInSteps(chosen.id)}>
              <ListTree size={13} aria-hidden="true" />
              Show in steps
            </button>
          )}
          <button
            type="button"
            className="file-tool file-copy"
            aria-label={copied === 'copied' ? 'Copied the file' : 'Copy the file'}
            title={copied === 'refused' ? 'The browser didn’t allow copying' : 'Copy the file'}
            data-copied={copied === 'copied' || undefined}
            onClick={() => void copy()}
            onBlur={() => setCopied(null)}
          >
            {copied === 'copied' ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
          </button>
        </span>
      </div>
      {placed.length > 0 && (
        <nav className="file-steps" aria-label="Steps in this file">
          {placed.map((step) => (
            <button
              key={step.id}
              type="button"
              className="file-step"
              aria-pressed={step.id === selected}
              title={rangeWords(step.range)}
              onClick={() => onSelect(step.id)}
            >
              {step.id}
            </button>
          ))}
        </nav>
      )}
      <p className="sr-only" aria-live="polite">
        {chosen?.range ? `${chosen.id}, ${rangeWords(chosen.range)}` : ''}
      </p>
      <section
        className="file-scroll"
        aria-label={`${source.path}, version ${source.version}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls takes the keyboard, or it cannot be scrolled without a pointer.
        tabIndex={0}
      >
        <pre className="file-code">
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click on a step's lines is a pointer's shortcut; the keyboard chooses a step by its name above, or in the steps. */}
          <code onClick={choose}>
            {lines.map((line) => (
              <span
                key={line.number}
                ref={(element) => {
                  if (element) lineRefs.current.set(line.number, element);
                  else lineRefs.current.delete(line.number);
                }}
                className="file-line"
                data-own={line.own || undefined}
                data-step={line.step ?? undefined}
                data-chosen={chosen?.range && inRange(line.number, chosen.range) ? '' : undefined}
              >
                <span className="file-num" aria-hidden="true">
                  {line.number}
                </span>
                <span className="file-src">
                  {line.tokens.length === 0
                    ? ' '
                    : line.tokens.map((token, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a line's tokens never move; their place is who they are.
                        <span key={index} className={`y-${token.kind}`}>
                          {token.text}
                        </span>
                      ))}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </section>
    </div>
  );
}
