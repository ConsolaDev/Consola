import type { AutomationView, RunRecord } from '../../../shared/automations';

/*
 * A run's own checkout as its run page and its entry's pipeline say it
 * (slice 3-B Task 22). Pure: the components draw what these return.
 */

/** A commit as a line names it: its first 7 characters. */
const short = (commit: string) => commit.slice(0, 7);

/** A session the run recorded, by its name; one the workspace no longer has, or none the run saw, reads `a session`. */
const sessionName = (id: string | undefined, names: Readonly<Record<string, string>>) =>
  id !== undefined && Object.prototype.hasOwnProperty.call(names, id) ? names[id] : 'a session';

/** What the run page shows of a run's own checkout, above its steps. */
export interface CheckoutLines {
  heading: 'Checkout';
  /** `<repo> · <branch>`, `from <base> · now <head>`, and where a removed checkout's commit is kept. */
  lines: string[];
  /** Under *Changed by you during the run*: each commit a person's session left, and the paths it flagged. */
  byPerson: Array<{ line: string; flagged: string[] }>;
  /** While a person's session open there holds the run. */
  held: string | undefined;
}

/**
 * While a person's session in the run's own checkout holds the run before
 * its next step: ``waiting for you to close `fix`, open in this run's
 * checkout``, `names` giving each session id its name. Undefined otherwise.
 */
export function heldLine(
  run: Pick<RunRecord, 'waitingFor'>,
  names: Readonly<Record<string, string>>,
): string | undefined {
  const session = run.waitingFor?.session;
  if (session === undefined) return undefined;
  const name = Object.prototype.hasOwnProperty.call(names, session)
    ? `\`${names[session]}\``
    : 'a session';
  return `waiting for you to close ${name}, open in this run's checkout`;
}

/**
 * A run's own checkout (`kind: 'run-owned'`) as its page lists it: its
 * repository and branch, the commit it cut from and the one it is at, the
 * commits people's sessions added during the run with what each flagged,
 * and the session holding it. Null for any other run, whose checkout is an
 * item's or a scope's.
 */
export function checkoutLines(
  run: Pick<RunRecord, 'checkout' | 'waitingFor'>,
  names: Readonly<Record<string, string>>,
): CheckoutLines | null {
  const checkout = run.checkout;
  if (checkout?.kind !== 'run-owned') return null;
  const lines = [`${checkout.repo ?? 'its repository'} · ${checkout.branch ?? 'its branch'}`];
  if (checkout.base !== undefined && checkout.head !== undefined) {
    lines.push(`from ${short(checkout.base)} · now ${short(checkout.head)}`);
  }
  if (checkout.removed) {
    lines.push(
      `removed by cleanup; its commit ${short(checkout.removed.commit)} is kept in your clone`,
    );
  }
  return {
    heading: 'Checkout',
    lines,
    byPerson: (checkout.byPerson ?? []).map((commit) => ({
      line: `${sessionName(commit.session, names)} · ${commit.files} files · ${short(commit.after)}`,
      flagged: (commit.flagged ?? []).map((flagged) => `changed ${flagged}`),
    })),
    held: heldLine(run, names),
  };
}

type PipelineStep = NonNullable<AutomationView['steps']>[number];

/**
 * A write agent's step as its pipeline node's chip says it: `ui-bugfixer ·
 * writes · sandboxed`, or `… · writes · host, a convention`. Null for any
 * other step.
 */
export function writeChip(step: PipelineStep): string | null {
  if (step.writes === undefined) return null;
  const agent = step.agentFile?.replace(/^agents\//, '').replace(/\.md$/, '') ?? step.id;
  return `${agent} · writes · ${step.writes === 'sandbox' ? 'sandboxed' : 'host, a convention'}`;
}

/**
 * An entry's own checkout as its pipeline's first step draws it: the branch
 * it cuts, from the repository by its name (`fix/<ticket> from
 * catalog-portal`). Null for an entry without one.
 */
export function checkoutNode(
  checkout: AutomationView['checkout'],
): { title: string; repo: string } | null {
  if (!checkout) return null;
  const name = checkout.repo.split('/').pop() ?? checkout.repo;
  return { title: `${checkout.branch} from ${name}`, repo: checkout.repo };
}
