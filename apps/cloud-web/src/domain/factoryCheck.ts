import { parseFactory, storedFactoryFiles } from '@consola/factory-spec';
import { type FactoryProblem, problemOf } from './factoryProblems';

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
  return parseFactory(storedFactoryFiles(files)).issues.map(problemOf);
}
