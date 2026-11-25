import { and, asc, desc, eq, exists, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { RunFilter, RunFound, RunStore } from '../../application/ports.js';
import {
  type CheckedRun,
  childCountsOf,
  NO_RUNS,
  type Phase,
  type PhaseCounts,
  phaseOf,
  progressOf,
  type RunSummary,
  type RunWrite,
  requestPhase,
  stepRecordOf,
} from '../../domain/run.js';
import type { RunAnswer } from '../../domain/runApproval.js';
import type { Database } from './database.js';
import { FOREIGN_KEY_VIOLATION, failedWith } from './sqlState.js';
import { factories, runApprovals, runs } from './tables.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

const child = alias(runs, 'child');

/** What a summary reads of a run's row and its factory's. */
const SUMMARY = {
  id: runs.runId,
  kind: runs.kind,
  title: runs.title,
  status: runs.status,
  phase: runs.phase,
  waitingOn: runs.waitingOn,
  factoryId: runs.factoryId,
  factoryName: factories.name,
  factoryVersion: runs.factoryVersion,
  teamId: factories.teamId,
  automation: runs.automation,
  parentId: runs.parentRunId,
  trigger: runs.trigger,
  triggerDetail: runs.triggerDetail,
  startedBy: runs.startedBy,
  item: runs.item,
  runner: runs.runner,
  steps: runs.steps,
  summary: runs.summary,
  error: runs.error,
  costUsd: runs.costUsd,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  updatedAt: runs.updatedAt,
};

type SummaryRow = {
  [Key in keyof typeof SUMMARY]: (typeof SUMMARY)[Key]['_']['notNull'] extends true
    ? (typeof SUMMARY)[Key]['_']['data']
    : (typeof SUMMARY)[Key]['_']['data'] | null;
};

const iso = (time: Date | null) => (time === null ? null : time.toISOString());

/** What a run's record reads of its row: every column the runner's record was stored in. */
const RECORD = {
  runId: runs.runId,
  factoryId: runs.factoryId,
  factoryVersion: runs.factoryVersion,
  parentRunId: runs.parentRunId,
  parentMove: runs.parentMove,
  automation: runs.automation,
  status: runs.status,
  waitingOn: runs.waitingOn,
  trigger: runs.trigger,
  triggerDetail: runs.triggerDetail,
  startedBy: runs.startedBy,
  item: runs.item,
  runner: runs.runner,
  steps: runs.steps,
  request: runs.request,
  requestText: runs.requestText,
  summary: runs.summary,
  error: runs.error,
  costUsd: runs.costUsd,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  updatedAt: runs.updatedAt,
};

type RecordRow = {
  [Key in keyof typeof RECORD]: (typeof RECORD)[Key]['_']['notNull'] extends true
    ? (typeof RECORD)[Key]['_']['data']
    : (typeof RECORD)[Key]['_']['data'] | null;
};

/** The record a row holds, as its runner sent it, its times as the cell stores them. */
function recordOfRow(row: RecordRow): RunWrite {
  return {
    id: row.runId,
    factoryId: row.factoryId,
    factoryVersion: row.factoryVersion,
    parent:
      row.parentRunId === null || row.parentMove === null
        ? null
        : { runId: row.parentRunId, move: row.parentMove },
    automation: row.automation,
    status: row.status,
    waitingOn: row.waitingOn,
    trigger: row.trigger,
    triggerDetail: row.triggerDetail,
    startedBy: row.startedBy,
    item: row.item,
    runner: row.runner,
    // A step stored before a field existed reads as having none of it.
    steps: row.steps.map(stepRecordOf),
    request:
      row.request !== null && row.requestText !== null
        ? { ...row.request, text: row.requestText }
        : null,
    summary: row.summary,
    error: row.error,
    costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What an answer reads of its row. */
const ANSWER = {
  decision: runApprovals.decision,
  by: runApprovals.personId,
  at: runApprovals.answeredAt,
};

const answerOfRow = (row: {
  decision: RunAnswer['decision'];
  by: string;
  at: Date;
}): RunAnswer => ({
  decision: row.decision,
  by: row.by,
  at: row.at.toISOString(),
});

/** A summary of a row, with a request's children's phases (none for an automation run). */
function summaryOf(row: SummaryRow, childPhases: readonly Phase[]): RunSummary {
  const isRequest = row.kind === 'request';
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    phase: row.phase,
    waitingOn: row.waitingOn,
    factory: { id: row.factoryId, name: row.factoryName, version: row.factoryVersion },
    teamId: row.teamId,
    automation: row.automation,
    parentId: row.parentId,
    trigger: row.trigger,
    triggerDetail: row.triggerDetail,
    startedBy: row.startedBy,
    item: row.item,
    runner: row.runner,
    progress: isRequest ? null : progressOf(row.steps),
    children: isRequest ? childCountsOf(childPhases) : null,
    summary: row.summary,
    error: row.error,
    costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ofFactory = and(
  eq(factories.workspaceId, runs.workspaceId),
  eq(factories.factoryId, runs.factoryId),
);

/** `text` inside a LIKE pattern, its own `%`, `_` and `\` matched as themselves. */
const likeText = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The workspace's top-level runs the filter keeps, of every phase. */
function kept(db: Executor, workspaceId: string, filter: RunFilter): SQL | undefined {
  const { automation, q } = filter;
  return and(
    eq(runs.workspaceId, workspaceId),
    isNull(runs.parentRunId),
    inArray(runs.factoryId, [...filter.factoryIds]),
    filter.triggers.length > 0 ? inArray(runs.trigger, [...filter.triggers]) : undefined,
    filter.startedBy !== null ? eq(runs.startedBy, filter.startedBy) : undefined,
    automation !== null
      ? or(
          eq(runs.automation, automation),
          exists(
            db
              .select({ one: sql`1` })
              .from(child)
              .where(
                and(
                  eq(child.workspaceId, runs.workspaceId),
                  eq(child.parentRunId, runs.runId),
                  eq(child.automation, automation),
                ),
              ),
          ),
        )
      : undefined,
    q !== null
      ? or(ilike(runs.title, `%${likeText(q)}%`), ilike(runs.automation, `%${likeText(q)}%`))
      : undefined,
  );
}

/** Each request's children's phases, by the request's id: one read for a page of requests. */
async function childPhasesOf(
  db: Executor,
  workspaceId: string,
  requestIds: readonly string[],
): Promise<Map<string, Phase[]>> {
  const phases = new Map<string, Phase[]>();
  if (requestIds.length === 0) return phases;
  const rows = await db
    .select({ parentId: runs.parentRunId, phase: runs.phase })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), inArray(runs.parentRunId, [...requestIds])));
  for (const { parentId, phase } of rows) {
    if (parentId === null) continue;
    phases.set(parentId, [...(phases.get(parentId) ?? []), phase]);
  }
  return phases;
}

/** Summaries of rows, each request with its children's counts. */
async function summariesOf(
  db: Executor,
  workspaceId: string,
  rows: readonly SummaryRow[],
): Promise<RunSummary[]> {
  const requests = rows.filter((row) => row.kind === 'request').map((row) => row.id);
  const phases = await childPhasesOf(db, workspaceId, requests);
  return rows.map((row) => summaryOf(row, phases.get(row.id) ?? []));
}

/** The phases of a request's children, read in the recording's transaction. */
async function phasesUnder(tx: Transaction, workspaceId: string, requestId: string) {
  const rows = await tx
    .select({ phase: runs.phase })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.parentRunId, requestId)));
  return rows.map((row) => row.phase);
}

const at = (time: string | null) => (time === null ? null : new Date(time));

/** The row a checked run is stored as, its phase as `phase` says. */
function rowOf(workspaceId: string, run: CheckedRun, phase: Phase) {
  return {
    workspaceId,
    runId: run.id,
    factoryId: run.factoryId,
    factoryVersion: run.factoryVersion,
    parentRunId: run.parent?.runId ?? null,
    parentMove: run.parent?.move ?? null,
    kind: run.kind,
    automation: run.automation,
    title: run.title,
    status: run.status,
    waitingOn: run.waitingOn,
    phase,
    trigger: run.trigger,
    triggerDetail: run.triggerDetail,
    startedBy: run.startedBy,
    item: run.item,
    runner: run.runner,
    steps: [...run.steps],
    request:
      run.request === null
        ? null
        : { budget: run.request.budget, spent: run.request.spent, question: run.request.question },
    requestText: run.request?.text ?? null,
    summary: run.summary,
    error: run.error,
    costUsd: run.costUsd,
    createdAt: new Date(run.createdAt),
    startedAt: at(run.startedAt),
    finishedAt: at(run.finishedAt),
    updatedAt: new Date(run.updatedAt),
  };
}

/** Recording, after the parent and the run's own row are held: `stale` when it is older. */
async function recordHeld(tx: Transaction, workspaceId: string, run: CheckedRun) {
  const phase =
    run.kind === 'request'
      ? requestPhase(run.ownPhase, await phasesUnder(tx, workspaceId, run.id))
      : run.ownPhase;
  const row = rowOf(workspaceId, run, phase);
  const { workspaceId: _w, runId: _r, ...changes } = row;
  // The compare-and-set: a record older than the one held changes nothing.
  const written = await tx
    .insert(runs)
    .values(row)
    .onConflictDoUpdate({
      target: [runs.workspaceId, runs.runId],
      set: changes,
      setWhere: sql`${runs.updatedAt} <= excluded.updated_at`,
    })
    .returning({ id: runs.runId });
  return written.length > 0;
}

/** The workspace's runs on the cell's database. */
export function createRunStore(db: Database): RunStore {
  return {
    async record(workspaceId, run) {
      try {
        return await db.transaction(async (tx) => {
          // A child's request first, held while the child is written, so two of its runs
          // recorded at once roll its phase up one after the other.
          let parent: { status: CheckedRun['status']; waitingOn: CheckedRun['waitingOn'] } | null =
            null;
          if (run.parent !== null) {
            const [held] = await tx
              .select({ status: runs.status, waitingOn: runs.waitingOn })
              .from(runs)
              .where(
                and(
                  eq(runs.workspaceId, workspaceId),
                  eq(runs.factoryId, run.factoryId),
                  eq(runs.runId, run.parent.runId),
                  eq(runs.kind, 'request'),
                ),
              )
              .for('update');
            if (!held) return 'parent-not-found' as const;
            parent = held;
          }

          const [stored] = await tx
            .select({
              kind: runs.kind,
              factoryId: runs.factoryId,
              parentRunId: runs.parentRunId,
              parentMove: runs.parentMove,
            })
            .from(runs)
            .where(and(eq(runs.workspaceId, workspaceId), eq(runs.runId, run.id)))
            .for('update');
          if (
            stored &&
            (stored.kind !== run.kind ||
              stored.factoryId !== run.factoryId ||
              stored.parentRunId !== (run.parent?.runId ?? null) ||
              stored.parentMove !== (run.parent?.move ?? null))
          ) {
            return 'identity-changed' as const;
          }

          if (!(await recordHeld(tx, workspaceId, run))) return 'stale' as const;

          if (run.parent !== null && parent !== null) {
            const rolled = requestPhase(
              phaseOf(parent.status, parent.waitingOn),
              await phasesUnder(tx, workspaceId, run.parent.runId),
            );
            await tx
              .update(runs)
              .set({ phase: rolled })
              .where(and(eq(runs.workspaceId, workspaceId), eq(runs.runId, run.parent.runId)));
          }
          return 'recorded' as const;
        });
      } catch (error) {
        // The only key a run points along that the transaction does not read first is its
        // factory's version.
        if (failedWith(error, FOREIGN_KEY_VIOLATION)) return 'factory-not-found';
        throw error;
      }
    },

    async list(workspaceId, filter, { phases, after, limit }) {
      if (filter.factoryIds.length === 0) return { runs: [], next: null };
      const rows = await db
        .select(SUMMARY)
        .from(runs)
        .innerJoin(factories, ofFactory)
        .where(
          and(
            kept(db, workspaceId, filter),
            phases.length > 0 ? inArray(runs.phase, [...phases]) : undefined,
            after !== null
              ? sql`(${runs.createdAt}, ${runs.runId}) < (${after.createdAt}::timestamptz, ${after.id})`
              : undefined,
          ),
        )
        .orderBy(desc(runs.createdAt), desc(runs.runId))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        runs: await summariesOf(db, workspaceId, page),
        next:
          rows.length > limit && last
            ? { createdAt: last.createdAt.toISOString(), id: last.id }
            : null,
      };
    },

    async count(workspaceId, filter) {
      if (filter.factoryIds.length === 0) return NO_RUNS;
      const rows = await db
        .select({ phase: runs.phase, runs: sql<number>`count(*)::int` })
        .from(runs)
        .where(kept(db, workspaceId, filter))
        .groupBy(runs.phase);
      const counts: Record<Phase, number> = { ...NO_RUNS };
      for (const row of rows) counts[row.phase] = Number(row.runs);
      return counts satisfies PhaseCounts;
    },

    async automations(workspaceId, factoryIds) {
      if (factoryIds.length === 0) return [];
      const rows = await db
        .selectDistinct({ factoryId: runs.factoryId, name: runs.automation })
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, workspaceId),
            inArray(runs.factoryId, [...factoryIds]),
            sql`${runs.automation} is not null`,
          ),
        )
        .orderBy(asc(runs.automation), asc(runs.factoryId));
      return rows.flatMap(({ factoryId, name }) => (name === null ? [] : [{ factoryId, name }]));
    },

    async recordOf(workspaceId, runId) {
      const [row] = await db
        .select(RECORD)
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.runId, runId)));
      return row ? recordOfRow(row) : null;
    },

    async answeredWaiting(workspaceId, limit) {
      const rows = await db
        .select({ ...RECORD, ...ANSWER })
        .from(runs)
        .innerJoin(
          runApprovals,
          and(
            eq(runApprovals.workspaceId, runs.workspaceId),
            eq(runApprovals.runId, runs.runId),
            eq(runApprovals.version, runs.factoryVersion),
          ),
        )
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.status, 'needs-approval')))
        .orderBy(asc(runApprovals.answeredAt), asc(runs.runId))
        .limit(limit);
      return rows.map(({ decision, by, at, ...row }) => ({
        run: recordOfRow(row),
        answer: answerOfRow({ decision, by, at }),
      }));
    },

    async answerOf(workspaceId, runId, version) {
      const [row] = await db
        .select(ANSWER)
        .from(runApprovals)
        .where(
          and(
            eq(runApprovals.workspaceId, workspaceId),
            eq(runApprovals.runId, runId),
            eq(runApprovals.version, version),
          ),
        );
      return row ? answerOfRow(row) : null;
    },

    async answer(workspaceId, runId, { version, decision, personId }) {
      try {
        // The first answer for a version stands: a second inserts nothing.
        const [row] = await db
          .insert(runApprovals)
          .values({ workspaceId, runId, version, decision, personId })
          .onConflictDoNothing()
          .returning(ANSWER);
        return row ? answerOfRow(row) : 'already-answered';
      } catch (error) {
        // The only key an answer points along is its run's.
        if (failedWith(error, FOREIGN_KEY_VIOLATION)) return 'not-found';
        throw error;
      }
    },

    async get(workspaceId, runId): Promise<RunFound | null> {
      const [row] = await db
        .select({
          ...SUMMARY,
          request: runs.request,
          requestText: runs.requestText,
        })
        .from(runs)
        .innerJoin(factories, ofFactory)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.runId, runId)));
      if (!row) return null;
      const { request, requestText, ...summaryRow } = row;

      let parent: RunFound['parent'] = null;
      if (summaryRow.parentId !== null) {
        const [found] = await db
          .select({ id: runs.runId, title: runs.title })
          .from(runs)
          .where(and(eq(runs.workspaceId, workspaceId), eq(runs.runId, summaryRow.parentId)));
        parent = found ?? null;
      }

      const childRows =
        summaryRow.kind === 'request'
          ? await db
              .select(SUMMARY)
              .from(runs)
              .innerJoin(factories, ofFactory)
              .where(and(eq(runs.workspaceId, workspaceId), eq(runs.parentRunId, runId)))
              .orderBy(asc(runs.parentMove), asc(runs.createdAt), asc(runs.runId))
          : [];
      const children = childRows.map((childRow) => summaryOf(childRow, []));

      return {
        run: summaryOf(
          summaryRow,
          children.map((c) => c.phase),
        ),
        parent,
        // A step stored before a field existed reads as having none of it.
        steps: summaryRow.steps.map(stepRecordOf),
        request:
          request !== null && requestText !== null ? { ...request, text: requestText } : null,
        children,
      };
    },
  };
}
