import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import type { FactoryFile } from './factory.js';

/** A ready-made set of factory files a person can start a factory from. */
export type FactoryTemplate = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly files: readonly FactoryFile[];
};

/** The code review team: factory-spec's ready-made agent team, as it is written there. */
export const CODE_REVIEW_TEAM_TEMPLATE: FactoryTemplate = {
  id: 'code-review-team',
  name: 'Code review team',
  description:
    'A foreman and a review agent that review every pull request opened, reopened or marked ready in the repositories the runner offers, and post the review on GitHub.',
  files: CODE_REVIEW_TEAM_FILES,
};

/**
 * The templates the web app offers, in the order it lists them. Their files are merged into a
 * factory through the ordinary save, so they are checked as any other files are.
 */
export const FACTORY_TEMPLATES: readonly FactoryTemplate[] = [CODE_REVIEW_TEAM_TEMPLATE];
