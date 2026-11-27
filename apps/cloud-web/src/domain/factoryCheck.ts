import {
  hasAgentTeam,
  parseAgentTeam,
  parseFactory,
  storedFactoryFiles,
} from '@consola/factory-spec';
import { problemOf } from './factoryProblems';
import type { FactoryProblem } from './factoryProblems';

/**
 * A factory's files checked as the person edits them, with the rules the API checks a save
 * with: factory-spec's parser, over the set read as the API reads it (`storedFactoryFiles`). So
 * what the page says before a save is what the API would say, but for the limits only the API
 * keeps (how many files and bytes a factory may hold), which its answer to the save says.
 *
 * A set may also hold an agent team, in its own layout (`agents/<name>/agent.md`,
 * `automations/<name>/automation.md`, `skills/<name>/…`). As the API's `checkFactoryFiles`
 * (`apps/cloud-api/src/company/domain/factory.ts`) does, the files in the team's own trees are left
 * out of the steps design's parse when the set holds a team (`hasAgentTeam`), which would take
 * them for strays, and factory-spec's `parseAgentTeam` checks the team, each issue naming its
 * file. Keep the two in step.
 *
 * This module carries the parsers (YAML, the schema) and is the one the page loads late, with
 * `import()`, once a factory's definition opens.
 */
export function checkFactory(
  files: ReadonlyArray<{ path: string; content: string }>,
): FactoryProblem[] {
  return factoryCheckOf(files).problems;
}

/** What one check of the files found: their problems, and what a new file's name could clash with. */
export type FactoryCheck = {
  problems: FactoryProblem[];
  /** The automations `factory.yml` defines under `automations:`, as the parser kept them. */
  definedAutomations: string[];
};

export function factoryCheckOf(
  files: ReadonlyArray<{ path: string; content: string }>,
): FactoryCheck {
  const team = hasAgentTeam(files);
  const parsed = parseFactory(storedFactoryFiles(team ? files.filter(isStepsFile) : files));
  const teamIssues = team ? parseAgentTeam(files).issues : [];
  return {
    problems: [...parsed.issues, ...teamIssues].map(problemOf),
    definedAutomations: parsed.automations
      .filter((automation) => automation.file === 'factory.yml')
      .map((automation) => automation.name),
  };
}

/**
 * Whether the steps design's parser reads a path in a set that holds a team: every path but
 * those in the team's own trees, `agents/<name>/…` and `automations/<name>/…` (the steps
 * design's own files there are `agents/<name>.md` and `automations/<name>.yaml`).
 * `skills/<name>/` is shared by both designs.
 */
function isStepsFile({ path }: { path: string }): boolean {
  const parts = path.split('/');
  return !(parts.length >= 3 && (parts[0] === 'agents' || parts[0] === 'automations'));
}
