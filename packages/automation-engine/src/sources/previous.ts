import type { RunRecord } from '@consola/factory-spec';
import type { RunFolderPort } from '../ports';

/*
 * `previous`: what the last completed run of the same automation on the same
 * item wrote. Which run that is, decided from history alone, and one of its
 * documents, read from its folder. A step reads it as material (`reads:`) or
 * as an `env:` value; it is never a dependency, and absent is normal.
 */

/** What a step is told, and a read is refused with, when this run has no earlier one. */
export const NO_EARLIER_RUN = 'There is no earlier run of this automation on this item.';

/** Where a `previous` document came from, as the prompt and the material fence name it: `step "review" <this>`. */
export const OF_EARLIER_RUN = 'of the earlier run on this item';

/** Created strictly before `than`, a tie in time broken by id, so two runs are never each other's earlier. */
function createdBefore(run: RunRecord, than: RunRecord): boolean {
  const at = Date.parse(run.createdAt);
  const thanAt = Date.parse(than.createdAt);
  if (Number.isNaN(at) || Number.isNaN(thanAt)) return false;
  return at < thanAt || (at === thanAt && run.id < than.id);
}

/**
 * The newest run `previous` names for `run`, by the spec's four rules; undefined when none:
 * the same automation in the same workspace; the same item key, or also no
 * item when this run has none; completed and not a dry run; with steps, and
 * created before this one.
 */
export function resolvePrevious(runs: readonly RunRecord[], run: RunRecord): RunRecord | undefined {
  const workspaceId = run.attribution.workspaceId;
  if (workspaceId === undefined) return undefined;
  const key = run.trigger.item?.key;
  let newest: RunRecord | undefined;
  for (const candidate of runs) {
    if (candidate.id === run.id) continue;
    if (
      candidate.automationId !== run.automationId ||
      candidate.attribution.workspaceId !== workspaceId
    )
      continue;
    if (candidate.trigger.item?.key !== key) continue;
    if (candidate.status !== 'completed' || candidate.dryRun) continue;
    if (!candidate.steps || candidate.steps.length === 0) continue;
    if (!createdBefore(candidate, run)) continue;
    if (!newest || createdBefore(newest, candidate)) newest = candidate;
  }
  return newest;
}

/**
 * One document of the previous run: its content, or with `file` its absolute
 * file; else why there is none. It is read at the step's latest attempt in
 * that run's folder (Call 31), so it is still there when retention dropped
 * the record and the sweep kept the folder; the record, when history still
 * has it, says only whether the step completed. May throw on a folder that
 * cannot be read: each caller has its own way to fail.
 */
export function previousDocument(input: {
  folder: RunFolderPort;
  workspaceId: string;
  previous: { runId: string } | undefined;
  /** The previous run's record, when history still has it. */
  record?: RunRecord;
  step: string;
  name: string;
  file: boolean;
}): { value: string } | { absent: string } {
  const { folder, workspaceId, previous, record, step, name, file } = input;
  if (!previous) return { absent: NO_EARLIER_RUN };
  if (record && record.steps?.find((candidate) => candidate.id === step)?.status !== 'completed') {
    return { absent: `\`${step}\` did not complete in the earlier run` };
  }
  const notWritten = { absent: `\`previous.${step}.${name}\` was not written in the earlier run` };
  const attempt = folder.latestAttempt(workspaceId, previous.runId, step);
  if (attempt === null) return notWritten;
  if (file) {
    // A command's `output` is kept as JSON or as text; which, its file says.
    const formats = name === 'output' ? (['json', 'text'] as const) : ([undefined] as const);
    for (const format of formats) {
      const artifactFile = folder.artifactPath(
        workspaceId,
        previous.runId,
        step,
        attempt,
        name,
        format,
      );
      if (folder.exists(artifactFile)) return { value: artifactFile };
    }
    return notWritten;
  }
  const content = folder.readArtifact(workspaceId, previous.runId, step, attempt, name);
  return content === null ? notWritten : { value: content };
}
