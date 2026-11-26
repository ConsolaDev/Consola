import type { GitHubTokenPurpose } from '@consola/cloud-contract';
import { leafSteps } from '@consola/factory-spec';
import type { Automation, StepPermissions } from '@consola/factory-spec';
import { TOKEN_REFUSAL_MAX } from '@consola/runner-protocol';
import type { GitHubPermissions } from '@consola/runner-protocol';
import type { RunWrite } from './run.js';

/**
 * Whether a runner may have a GitHub token for one step of a run (`github.token.request`), and
 * for which of `cloud-contract`'s purposes. The cell is the gate: `cloud-global` mints whatever a
 * purpose fixes for whichever cell signs, so the cell gives a run nothing its files did not
 * declare.
 *
 * - The run is the workspace's, and `running`.
 * - The repository is the run's item's, in any case (GitHub's names are).
 * - `contents: read` and `metadata: read` are always allowed: they are the run's checkout. Any
 *   other permission must be declared, at that level or above, in the `permissions:` of the
 *   step named, a `run:` step of the run's automation at the factory version it runs.
 * - The permissions asked are what one purpose grants (`purposeFor`), give or take what is
 *   always allowed; a purpose that would grant more, or less, is no match.
 *
 * Every refusal is a sentence for the run's page: it names permissions (lowercase snake_case, as
 * the protocol reads them), never a token.
 */

/** What every running run may have on its own repository: its checkout. */
export const ALWAYS_ALLOWED: Readonly<Record<string, 'read'>> = {
  contents: 'read',
  metadata: 'read',
};

/**
 * What each purpose a run may ask a token for grants, narrowest first, as `cloud-global` gives it
 * (`TOKEN_PURPOSES`, `apps/cloud-global/src/domain/gitHubTokens.ts`). `cloud-global` answers with
 * what it granted, and the cell hands a token on only when that is this (`grantedAsPurpose`), so
 * the two drifting apart refuses a token rather than widening one.
 */
export const RUN_TOKEN_PURPOSES: ReadonlyArray<{
  purpose: GitHubTokenPurpose;
  grants: Readonly<Record<string, 'read' | 'write'>>;
}> = [
  { purpose: 'run-read', grants: { contents: 'read' } },
  { purpose: 'review-run', grants: { contents: 'read', pull_requests: 'write' } },
];

export type Judged<T> = { ok: true; value: T } | { ok: false; reason: string };

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const named = (permissions: Readonly<Record<string, string>>): string =>
  Object.entries(permissions)
    .map(([name, level]) => `${name}: ${level}`)
    .join(', ');

/** A refusal's words, cut to the protocol's bound. */
export const refusalText = (reason: string): string => reason.slice(0, TOKEN_REFUSAL_MAX);

/** Whether the run may have a token on `repository` at all: the workspace's, running, its item's. */
export function judgeRun(run: RunWrite | null, repository: string): Judged<RunWrite> {
  if (!run) return refuse('The workspace holds no run with this id.');
  if (run.status !== 'running') {
    return refuse(`The run is ${run.status}: only a running run gets a GitHub token.`);
  }
  const repo = run.item?.repo ?? null;
  if (repo === null || repo.toLowerCase() !== repository.toLowerCase()) {
    return refuse("A run's GitHub token is only for its item's repository.");
  }
  return { ok: true, value: run };
}

/** The permissions asked beyond what every running run may have. */
export function beyondCheckout(asked: GitHubPermissions): Record<string, 'read' | 'write'> {
  return Object.fromEntries(
    Object.entries(asked).filter(([name, level]) => ALWAYS_ALLOWED[name] !== level),
  );
}

/**
 * The `permissions:` of step `stepId` of `automation`, as factory-spec parsed it (`{}` for a
 * `run:` step that writes none), or why there is none: no such step, or not a `run:` step. A
 * step inside a loop counts as the step it is.
 */
export function stepPermissionsOf(automation: Automation, stepId: string): Judged<StepPermissions> {
  const step = leafSteps(automation.steps ?? []).find((candidate) => candidate.id === stepId);
  if (!step) return refuse("The run's automation has no step with this id.");
  if (step.kind !== 'run') {
    return refuse('Only a `run:` step gets a GitHub token beyond its checkout.');
  }
  return { ok: true, value: step.permissions ?? {} };
}

const LEVEL: Readonly<Record<string, number | undefined>> = { read: 1, write: 2 };

/** Whether the step declares every permission in `beyond`, at that level or above. */
export function judgeDeclared(
  beyond: Readonly<Record<string, 'read' | 'write'>>,
  declared: StepPermissions,
): Judged<null> {
  const levels: Readonly<Record<string, string | undefined>> = declared;
  const missing = Object.fromEntries(
    Object.entries(beyond).filter(
      ([name, level]) => (LEVEL[levels[name] ?? ''] ?? 0) < (LEVEL[level] ?? 0),
    ),
  );
  if (Object.keys(missing).length === 0) return { ok: true, value: null };
  return refuse(
    `The step does not declare ${named(missing)} in its permissions, so its run gets no token for it.`,
  );
}

/**
 * The purpose whose grant is exactly what was asked, give or take what every run may have
 * (`ALWAYS_ALLOWED`), the narrowest first; or why none is.
 */
export function purposeFor(
  asked: GitHubPermissions,
): Judged<{ purpose: GitHubTokenPurpose; grants: Readonly<Record<string, 'read' | 'write'>> }> {
  const wanted = Object.entries(asked).filter(([name]) => name !== 'metadata');
  for (const candidate of RUN_TOKEN_PURPOSES) {
    const grants: Readonly<Record<string, string | undefined>> = candidate.grants;
    const covers = wanted.every(([name, level]) => grants[name] === level);
    const noMore = Object.entries(candidate.grants).every(
      ([name, level]) => asked[name] === level || ALWAYS_ALLOWED[name] === level,
    );
    if (covers && noMore) return { ok: true, value: candidate };
  }
  return refuse(
    `No GitHub token a run can have grants exactly ${named(asked)}: a run's token reads its ` +
      'repository (contents: read) or also writes pull requests (pull_requests: write).',
  );
}

/**
 * Whether what `cloud-global` granted is exactly the purpose's grant, and the metadata read
 * GitHub gives every token, nothing more or less.
 */
export function grantedAsPurpose(
  grants: Readonly<Record<string, 'read' | 'write'>>,
  granted: Readonly<Record<string, string | undefined>>,
): boolean {
  const given = Object.entries(granted).filter(([, level]) => level !== undefined);
  return (
    given.every(
      ([name, level]) => grants[name] === level || (name === 'metadata' && level === 'read'),
    ) && Object.entries(grants).every(([name, level]) => granted[name] === level)
  );
}

/** What `cloud-global` answered a token request with, when it gave none. */
export type MintRefusal =
  | 'unsigned'
  | 'unreadable'
  | 'invalid-request'
  | 'other-region'
  | 'installation-not-found'
  | 'installation-gone'
  | 'repository-not-covered'
  | 'scope-refused'
  | 'github-not-configured'
  | 'unavailable';

/** Each of `cloud-global`'s refusals, in words for the run's page. */
export const MINT_REFUSALS: Record<MintRefusal, string> = {
  unsigned: "cloud-global did not take the cell's request: no cell key it holds checks it.",
  unreadable: "cloud-global could not read the cell's request.",
  'invalid-request': "cloud-global refused the repositories in the cell's request.",
  'other-region': "cloud-global holds the workspace in another region than this cell's.",
  'installation-not-found':
    "The workspace no longer holds the GitHub installation the repository's events came through.",
  'installation-gone':
    "GitHub no longer has the installation the repository's events came through.",
  'repository-not-covered': 'The GitHub installation no longer covers this repository.',
  'scope-refused':
    'GitHub refused these permissions on this repository: the app may not have been granted them.',
  'github-not-configured': 'cloud-global has no GitHub App set up.',
  unavailable: 'cloud-global or GitHub did not answer as it should. Ask again later.',
};
