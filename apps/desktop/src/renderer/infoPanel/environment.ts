/**
 * What the info panel's Environment section says about a session: where it
 * runs, under which harness and account, and with which model. Pure, so the
 * wording is decided here and the section only draws it.
 */
import type { HarnessAccount, HarnessCapabilityAccount, HarnessModel } from '../../shared/types';
import type { Session } from '../../shared/workspace';
import type { TabFacts } from '../sidePanel/tabKinds';
import { shortModelName } from '../utils/harnessMark';

export type FolderLine =
  | { kind: 'removed' }
  | { kind: 'folder'; label: 'Worktree' | 'Main checkout' | 'Folder' | null; path: string };

const CHECKOUT_LABELS = {
  worktree: 'Worktree',
  main: 'Main checkout',
  none: 'Folder',
} as const;

/**
 * The folder the session works in, which follows the agent should it have
 * moved itself (`checkoutPath` is `checkoutPathForSession`'s). Its label is
 * what git says the folder is, and null until git has answered. A removed
 * worktree says so instead, and a session with no folder at all has no line.
 */
export function folderLine(
  facts: Pick<TabFacts, 'session' | 'checkout' | 'checkoutPath'>,
): FolderLine | null {
  if (facts.session.removedWorktree) return { kind: 'removed' };
  if (facts.checkoutPath === undefined) return null;
  return {
    kind: 'folder',
    label: facts.checkout ? CHECKOUT_LABELS[facts.checkout.kind] : null,
    path: facts.checkoutPath,
  };
}

/**
 * The harness row: the driver and the harness's name, the account it is
 * signed in as, and the session's model. Each is the CLI's own word where it
 * has one: the account it reported signed in (the capabilities cache), else
 * the one read from its config folder; the model by the name the CLI lists it
 * under, else the id said the way a person says it.
 */
export function harnessLine(input: {
  driverLabel: string;
  harnessName?: string;
  capabilityAccount?: HarnessCapabilityAccount;
  healthAccount?: HarnessAccount;
  model?: string;
  models?: readonly HarnessModel[];
}): { label: string; account?: string; model?: string } {
  const { driverLabel, harnessName, capabilityAccount, healthAccount, model, models } = input;
  const account = capabilityAccount?.signedIn
    ? capabilityAccount.emailAddress
    : (healthAccount?.emailAddress ?? healthAccount?.displayName);
  const modelName = model
    ? (models?.find((candidate) => candidate.value === model)?.displayName ?? shortModelName(model))
    : undefined;
  return {
    label: harnessName ? `${driverLabel} · ${harnessName}` : driverLabel,
    ...(account ? { account } : {}),
    ...(modelName ? { model: modelName } : {}),
  };
}

/**
 * What a session with a policy may do, naming the automation that started
 * it: `Read-only`, or for a write step (slice 3-B) `writes · sandboxed` or
 * `writes · host, a convention`, as its grants' environment says (the
 * weaker claim when they name none); null for a session with full tools.
 * The sidebar's row, the content view's bar and the info panel all read it.
 */
export function policyLine(
  session: Pick<Session, 'toolPolicy' | 'automation' | 'grants'>,
): string | null {
  const policy = session.toolPolicy;
  if (policy === undefined) return null;
  const by = session.automation?.name ? ` · started by ${session.automation.name}` : '';
  if (policy === 'read-only') return `Read-only${by}`;
  const where =
    session.grants?.environment?.isolation === 'sandbox' ? 'sandboxed' : 'host, a convention';
  return `writes · ${where}${by}`;
}

/** Whether the work item's pane may paste a fix into this session: only one with full tools. */
export function offersFixInSession(session: Pick<Session, 'toolPolicy'>): boolean {
  return session.toolPolicy === undefined;
}

/**
 * Splits `text` for a middle truncation: the head, which may be cut with an
 * ellipsis, and the last `tail` characters, which are always drawn whole.
 * A text no longer than `tail` is all tail.
 */
export function splitForMiddle(text: string, tail: number): [head: string, tail: string] {
  if (text.length <= tail) return ['', text];
  const cut = text.length - tail;
  return [text.slice(0, cut), text.slice(cut)];
}
