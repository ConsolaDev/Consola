import { Check, ChevronRight, CircleAlert, CornerDownRight } from 'lucide-react';
import { CELL_FOUND_PROBLEMS, CHECK_UNAVAILABLE, problemsCount } from '../domain/factoryMessages';
import { type FactoryProblem, messageParts, problemPath } from '../domain/factoryProblems';

/**
 * The files' problems, under the editor: a head that says how many there are and folds the list,
 * then each problem with where it is (`agents/reviewer.md:4`), which opens the file at its line.
 * A problem that only shows another file's sits quieter, naming that file. When the last problem
 * is fixed the head says so with a check that draws itself (`cleared`), once.
 *
 * What the cell found on a save, and the page's own check did not, is said over the list
 * (`fromCell`).
 */
export function ProblemsPanel({
  problems,
  paths,
  open,
  cleared,
  nudge,
  fromCell,
  checkFailed,
  onToggle,
  onReveal,
}: {
  problems: readonly FactoryProblem[];
  paths: readonly string[];
  open: boolean;
  /** The last problem was just fixed: the head celebrates it once. */
  cleared: boolean;
  /** Save was asked for while problems stand: a new number shakes the head once. */
  nudge: number;
  fromCell: boolean;
  checkFailed: boolean;
  onToggle: () => void;
  onReveal: (problem: FactoryProblem, path: string) => void;
}) {
  const own = problems.filter((problem) => problem.cause === null).length;
  const listed = open && problems.length > 0;

  return (
    <section className="problems" data-open={listed ? '' : undefined} aria-label="Problems">
      <button
        type="button"
        key={nudge}
        className="problems-head"
        aria-expanded={problems.length > 0 ? open : undefined}
        data-nudged={nudge > 0 ? '' : undefined}
        disabled={problems.length === 0}
        onClick={onToggle}
      >
        {problems.length > 0 ? (
          <>
            <ChevronRight className="problems-fold" size={12} aria-hidden="true" />
            <CircleAlert className="problems-icon" size={14} aria-hidden="true" />
            <span>Problems</span>
            <span className="problems-count">{own}</span>
          </>
        ) : (
          <>
            <Check
              className="problems-clear"
              data-cleared={cleared ? '' : undefined}
              size={14}
              aria-hidden="true"
            />
            <span data-cleared={cleared ? '' : undefined}>{problemsCount(0)}</span>
          </>
        )}
      </button>
      {checkFailed && <p className="problems-note">{CHECK_UNAVAILABLE}</p>}
      {listed && (
        <>
          {fromCell && <p className="problems-note">{CELL_FOUND_PROBLEMS}</p>}
          <ul className="problems-list">
            {problems.map((problem, index) => {
              const path = problemPath(problem, paths);
              const place =
                path === null ? null : problem.line === null ? path : `${path}:${problem.line}`;
              const key = `${index}:${problem.file ?? ''}:${problem.line ?? ''}`;
              return (
                <li key={key} data-through={problem.cause !== null ? '' : undefined}>
                  <button
                    type="button"
                    className="problem"
                    disabled={path === null}
                    onClick={() => path !== null && onReveal(problem, path)}
                  >
                    {problem.cause !== null ? (
                      <CornerDownRight className="problem-icon" size={13} aria-hidden="true" />
                    ) : (
                      <CircleAlert className="problem-icon" size={13} aria-hidden="true" />
                    )}
                    <span className="problem-message">
                      {messageParts(problem.message).map((part, at) =>
                        part.code ? (
                          // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts never move.
                          <code key={at}>{part.text}</code>
                        ) : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts never move.
                          <span key={at}>{part.text}</span>
                        ),
                      )}
                    </span>
                    {place && <span className="problem-place">{place}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
