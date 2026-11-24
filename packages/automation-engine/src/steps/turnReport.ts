import type { StepRun } from '@consola/factory-spec';
import type { AgentHarnessQuery } from '../ports';
import type { TurnInitView, TurnOutcome, TurnReportView, TurnResultView } from '../views';
import type { RunDefinition } from './definition';

/*
 * What a step turn's report means, as pure functions: whether the turn
 * failed and in what words, the reminder's cap, which servers its `init` must
 * show and which it must not, and how its figures add to the step's record. The host parses the
 * CLI's stream; this reads only the views it hands over.
 */

/** The most of a kept line an error quotes. */
export const ERROR_LINE_MAX = 300;

/**
 * The CLI's text as an error quotes it: its own trailing full stops and
 * spaces dropped, so none is doubled, and cut at `ERROR_LINE_MAX` characters.
 */
function quoted(text: string): string {
  const said = text.trim().replace(/[.\s]+$/, '');
  return said.length > ERROR_LINE_MAX ? `${said.slice(0, ERROR_LINE_MAX)}…` : said;
}

/** Why an unattended turn did not finish, in the words every automation run uses; null when it exited cleanly. */
export function turnFailure(outcome: TurnOutcome): string | null {
  if (outcome.stopped) {
    // Stopped before it answered — by the person, the limit, or a
    // signal — whatever code the process exited with.
    return `It stopped before finishing: ${outcome.stopped.trim().replace(/[.\s]+$/, '')}.`;
  }
  if (outcome.exitCode === 0) return null;
  const said = outcome.lastLine?.trim().replace(/[.\s]+$/, '');
  return `It stopped before finishing (exit ${outcome.exitCode})${said ? `: ${said}` : ''}.`;
}

/** The last line the CLI printed outside its JSON, quoted; undefined when it printed none. */
function lastOtherLine(report: TurnReportView): string | undefined {
  for (let index = report.otherLines.length - 1; index >= 0; index--) {
    const line = quoted(report.otherLines[index]);
    if (line) return line;
  }
  return undefined;
}

/** What a result that did not succeed says: its text, else its API error, else its subtype. */
function resultFailure(result: TurnResultView): string {
  const text = result.text === undefined ? '' : quoted(result.text);
  if (text) return `It stopped before finishing: ${text}.`;
  const status = result.apiErrorStatus === undefined ? '' : quoted(String(result.apiErrorStatus));
  if (status) return `It stopped before finishing: API error ${status}.`;
  return `It stopped before finishing: the CLI reported ${quoted(result.subtype)}.`;
}

/**
 * A reporting turn's failure, first match wins; null when it succeeded. A
 * stop; the turn reaching its cap (`atTurnLimit`: no reminder, and what it
 * set is kept); `is_error`, whatever `subtype` says; a `subtype` that is not
 * `success`; no `result` line at all; a non-zero exit after a clean result.
 * What it quotes is the CLI's own: a result's text, else the last line it
 * printed outside its JSON, never Consola's lines in the pane (`lastLine`).
 * A failed `init` check comes before all of these, in its own words; the
 * caller applies it. A `reminder` at its cap says so: that cap is the
 * reminder's own, not the one the file sets.
 */
export function reportedFailure(
  outcome: TurnOutcome & { report: TurnReportView },
  { reminder = false }: { reminder?: boolean } = {},
): { error: string; atTurnLimit: boolean } | null {
  const failed = (error: string) => ({ error, atTurnLimit: false });
  if (outcome.stopped)
    return failed(turnFailure({ exitCode: outcome.exitCode, stopped: outcome.stopped })!);
  const { report, exitCode } = outcome;
  const { result } = report;
  if (result?.subtype === 'error_max_turns') {
    const who = reminder ? 'Its reminder' : 'It';
    return {
      error:
        report.maxTurns === undefined
          ? `${who} hit its turn limit before finishing.`
          : `${who} hit its limit of ${report.maxTurns} turns before finishing.`,
      atTurnLimit: true,
    };
  }
  if (result && (result.isError || result.subtype !== 'success'))
    return failed(resultFailure(result));
  const line = lastOtherLine(report);
  if (!result) {
    return failed(
      exitCode === 0
        ? `It ended without reporting how its turn went${line ? `: ${line}` : ''}.`
        : `It stopped before finishing (exit ${exitCode})${line ? `: ${line}` : ''}.`,
    );
  }
  if (exitCode !== 0) {
    // A clean result, then a failing exit: what it printed after, else what it answered.
    const said = line ?? (result.text === undefined ? '' : quoted(result.text));
    return failed(`It stopped before finishing (exit ${exitCode})${said ? `: ${said}` : ''}.`);
  }
  return null;
}

/** The reminder turn's cap: 1, and 2 per missing item, an output set counting as one and each document as one. */
export function reminderCap(missing: {
  outputs: string[];
  artifacts: string[];
  files?: readonly unknown[];
}): number {
  return (
    1 +
    2 *
      ((missing.outputs.length > 0 ? 1 : 0) +
        missing.artifacts.length +
        (missing.files?.length ?? 0))
  );
}

/**
 * The servers a step's agent names, each once, in its order: what its turn's
 * `init` must show connected. A narrowing is the host's to enforce; the
 * server itself must be there. None for a step with no agent.
 */
export function requiredServers(
  definition: RunDefinition,
  stepId: string,
): Array<{ name: string }> {
  const names: string[] = [];
  for (const server of definition.agents?.[stepId]?.mcpServers ?? [])
    if (!names.includes(server.name)) names.push(server.name);
  return names.map((name) => ({ name }));
}

/**
 * The harness a step's agent runs on, as a query naming no server and no
 * skill, so the host compiles nothing and probes nothing: what the `init`
 * check's words name. Undefined for a step with no agent (the default's).
 */
export function stepHarnessQuery(
  definition: RunDefinition,
  stepId: string,
): AgentHarnessQuery | undefined {
  const agent = definition.agents?.[stepId];
  if (!agent) return undefined;
  return {
    ...(agent.harnessId !== undefined ? { harnessId: agent.harnessId } : {}),
    mcpServers: [],
    skills: [],
    checkout: 'scope',
  };
}

/**
 * Why a turn's `init` fails its step, in the engine's words: the first
 * required server it did not load, or did not connect; null when every one is
 * there and connected. The CLI would run the turn without it.
 */
export function initProblem(
  required: Array<{ name: string }>,
  init: TurnInitView,
  harnessName: string,
): string | null {
  for (const { name } of required) {
    const server = init.servers.find((candidate) => candidate.name === name);
    if (!server)
      return `\`${name}\` was not loaded: it was removed from ${harnessName}, or it is blocked by its URL.`;
    if (server.status !== 'connected') {
      const where = init.signInHint ? `${harnessName} (${init.signInHint})` : harnessName;
      return `\`${name}\` was not connected (${server.status}). Sign in to it in ${where}, then retry this step.`;
    }
  }
  return null;
}

/**
 * The name of Consola's own MCP server on every step's turn, which carries
 * the step's tools: the one server a turn's `init` may list beside those its
 * agent grants. The host names it so in every session's MCP config.
 */
export const CONSOLA_SERVER_NAME = 'consola';

/**
 * Why a turn's `init` fails its step for what it loaded beyond its grants:
 * the first server, whatever its status, that is neither Consola's own nor
 * one the step's agent grants; null when there is none. The CLI's allow-list
 * should have kept it out, so a CLI that stops honouring it fails steps
 * rather than quietly starting servers (review M3). A step that grants no
 * server runs under `--strict-mcp-config`, which 2-A's checks rely on, so it
 * is not asked.
 */
export function strayServerProblem(
  required: Array<{ name: string }>,
  init: TurnInitView,
): string | null {
  if (required.length === 0) return null;
  for (const server of init.servers) {
    if (server.name === CONSOLA_SERVER_NAME) continue;
    if (required.some((granted) => granted.name === server.name)) continue;
    return `\`${server.name}\` was loaded, and this step's agent does not grant it: its CLI started a server Consola did not give the step, so the step stops rather than run beside it.`;
  }
  return null;
}

/**
 * Why a turn whose `init` never reached the engine fails its step, though it
 * ended cleanly: it may have run without a server its agent grants, which is
 * never a step that completes. Null when it grants none.
 */
export function uncheckedInitProblem(required: Array<{ name: string }>): string | null {
  const [first] = required;
  return first
    ? `Its turn never said which servers it loaded, so it may have run without \`${first.name}\`.`
    : null;
}

/**
 * The attempt's cost with one turn's report added. The CLI reports the
 * conversation's cost so far, and every turn of an attempt is one
 * conversation (a new session per attempt; its reminder and its resume after
 * a quit `--resume` it): so the turn's own cost is its total less what the
 * attempt has recorded, and the attempt's is then the total itself (canary
 * row 14, which found a resumed turn's `total_cost_usd` to be the running
 * total). A total below what the attempt recorded can only be a
 * conversation that started over, so it is the turn's own. A turn with no
 * result leaves no figure: a later turn's total holds whatever the CLI kept
 * of it.
 */
function attemptCost(
  recorded: number | undefined,
  reported: number | undefined,
): number | undefined {
  if (reported === undefined) return recorded;
  if (recorded === undefined || reported >= recorded) return reported;
  return recorded + reported;
}

/**
 * `record` with one reporting turn's figures added: its cost (see
 * `attemptCost`), its turns summed, the tools it was refused, the step's own
 * cap (`stepMaxTurns`), and the model its `init` named. A report with no
 * result adds nothing to `turn`.
 */
export function withTurnRecorded(
  record: StepRun,
  report: TurnReportView,
  stepMaxTurns: number | undefined,
): StepRun {
  const model = report.init?.model ?? record.model;
  const withModel: StepRun = model === undefined ? record : { ...record, model };
  const { result } = report;
  if (!result) return withModel;
  const before = record.turn ?? {};
  const costUsd = attemptCost(before.costUsd, result.costUsd);
  const turns = result.turns === undefined ? before.turns : (before.turns ?? 0) + result.turns;
  const deniedTools = [...(before.deniedTools ?? [])];
  for (const tool of result.deniedTools) if (!deniedTools.includes(tool)) deniedTools.push(tool);
  const turn: NonNullable<StepRun['turn']> = {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(stepMaxTurns !== undefined ? { maxTurns: stepMaxTurns } : {}),
    ...(deniedTools.length > 0 ? { deniedTools } : {}),
  };
  return Object.keys(turn).length > 0 ? { ...withModel, turn } : withModel;
}

/** Every step's `turn.costUsd` and every earlier attempt's `costUsd`, summed; undefined when none is set. */
export function runCostOf(steps: StepRun[]): number | undefined {
  let total: number | undefined;
  const add = (cost: number | undefined) => {
    if (cost !== undefined) total = (total ?? 0) + cost;
  };
  for (const step of steps) {
    add(step.turn?.costUsd);
    for (const earlier of step.previous ?? []) add(earlier.costUsd);
  }
  return total;
}
