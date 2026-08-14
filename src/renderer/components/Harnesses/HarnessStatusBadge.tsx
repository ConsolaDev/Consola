import type { HarnessAccount } from '../../../shared/types';
import type { HarnessStatus } from '../../stores/harnessStore';
import './styles.css';

/**
 * Plan names Claude reports, mapped to how the CLI itself describes them.
 * Unknown values are shown as-is rather than hidden, so a new plan tier still
 * tells the user something.
 */
const PLAN_LABELS: Record<string, string> = {
  claude_max: 'Claude Max Subscription',
  claude_pro: 'Claude Pro Subscription',
  claude_team: 'Claude Team Subscription',
  claude_enterprise: 'Claude Enterprise',
};

function describePlan(account: HarnessAccount): string | null {
  const { organizationType, organizationName } = account;
  if (organizationType && PLAN_LABELS[organizationType]) {
    return PLAN_LABELS[organizationType];
  }
  return organizationType ?? organizationName ?? null;
}

/**
 * One line describing what a harness resolved to.
 *
 * Mirrors what the CLI would tell you: who it is signed in as, on which plan,
 * or why it could not be reached.
 */
export function describeHarnessStatus(status: HarnessStatus | undefined): string {
  if (!status || status.state === 'unknown') return 'Not checked yet.';
  if (status.state === 'probing') return 'Checking…';
  if (status.state === 'error') return status.error ?? 'Unavailable.';

  const { account } = status;
  if (!account?.emailAddress && !account?.displayName) {
    return 'Found, but not signed in.';
  }

  const identity = account.emailAddress ?? account.displayName;
  const plan = describePlan(account);
  return plan ? `Authenticated as ${identity} · ${plan}` : `Authenticated as ${identity}`;
}

export function HarnessStatusDot({ status }: { status: HarnessStatus | undefined }) {
  const state = status?.state ?? 'unknown';
  return (
    <span
      className={`harness-status-dot harness-status-dot-${state}`}
      role="img"
      aria-label={`Status: ${state}`}
    />
  );
}
