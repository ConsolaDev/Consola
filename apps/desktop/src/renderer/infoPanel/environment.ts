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
 * What the CLI said about itself (the capabilities cache's answer), with what
 * the harness launched as when it said it (`launchSignature`).
 */
export interface CapabilitiesAnswer {
  signature?: string;
  account?: HarnessCapabilityAccount;
  models?: readonly HarnessModel[];
}

/**
 * The harness row: the driver and the harness's name, the account it is
 * signed in as, and the session's model. The CLI's answer counts only when it
 * is for the harness as it launches now (its `signature` is `signature`): an
 * edited harness is another install, maybe another account. Then it decides
 * the account: signed in, the email it gave, else the account read from the
 * config folder; signed out, none. With no such answer, or one that says
 * nothing of the account, the account read from the config folder. The model
 * is named as that answer lists it, else the id said the way a person says it.
 */
export function harnessLine(input: {
  driverLabel: string;
  harnessName?: string;
  /** What the harness launches as now. */
  signature?: string;
  answer?: CapabilitiesAnswer;
  healthAccount?: HarnessAccount;
  model?: string;
}): { label: string; account?: string; model?: string } {
  const { driverLabel, harnessName, signature, answer, healthAccount, model } = input;
  const current =
    answer?.signature !== undefined && answer.signature === signature ? answer : undefined;
  const onDisk = healthAccount?.emailAddress ?? healthAccount?.displayName;
  const said = current?.account;
  const account =
    said === undefined ? onDisk : said.signedIn ? (said.emailAddress ?? onDisk) : undefined;
  const modelName = model
    ? (current?.models?.find((candidate) => candidate.value === model)?.displayName ??
      shortModelName(model))
    : undefined;
  return {
    label: harnessName ? `${driverLabel} · ${harnessName}` : driverLabel,
    ...(account ? { account } : {}),
    ...(modelName ? { model: modelName } : {}),
  };
}

/** The read-only line, naming the automation that started the session; null for a session with full tools. */
export function readOnlyLine(session: Session): string | null {
  if (session.toolPolicy !== 'read-only') return null;
  return session.automation?.name
    ? `Read-only · started by ${session.automation.name}`
    : 'Read-only';
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
