import { parseFactory, storedFactoryFiles } from '@consola/factory-spec';
import { problemOf } from './factoryProblems';
import type { FactoryProblem } from './factoryProblems';

/**
 * A factory's files checked as the person edits them, with the rules the cell checks a save
 * with: factory-spec's parser, over the set read as the cell reads it (`storedFactoryFiles`). So
 * what the page says before a save is what the cell would say, but for the limits only the cell
 * keeps (how many files and bytes a factory may hold), which its answer to the save says.
 *
 * This module carries the parser (YAML, the schema) and is the one the page loads late, with
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
  const parsed = parseFactory(storedFactoryFiles(files));
  return {
    problems: parsed.issues.map(problemOf),
    definedAutomations: parsed.automations
      .filter((automation) => automation.file === 'factory.yml')
      .map((automation) => automation.name),
  };
}
