import { useEffect, useRef, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Folder, FolderGit2, GitBranch, Laptop, Lock } from 'lucide-react';
import { getDriverDescriptor } from '../../../shared/constants';
import type { CheckoutInfo } from '../../../shared/sessionCheckout';
import type { Session } from '../../../shared/workspace';
import { folderLine, harnessLine, policyLine, splitForMiddle } from '../../infoPanel/environment';
import type { FolderLine } from '../../infoPanel/environment';
import { useComputerName } from '../../infoPanel/useComputerName';
import type { TabFacts } from '../../sidePanel/tabKinds';
import {
  launchSignature,
  readCapabilities,
  useHarnessCapabilitiesStore,
} from '../../stores/harnessCapabilitiesStore';
import { toLaunchFields, useHarnessStore } from '../../stores/harnessStore';
import { tildePath } from '../../utils/displayPath';
import { basename } from '../../utils/fileUtils';
import { HarnessIcon } from '../HarnessIcon';
import { InfoRow } from './InfoRow';
import { InfoSection } from './InfoSection';
import { OpenInButton } from './OpenInButton';

/** How long "Copied the folder path" stays before the card or title explains again. */
const COPIED_MS = 1500;
/** How long the pointer rests on the Folder row before its card opens. */
const CARD_DELAY_MS = 300;
/** How much of a folder's path is always drawn: its end, which tells worktrees apart. */
const PATH_TAIL = 14;

const ICON_SIZE = 14;

/**
 * Where the session runs: the computer, the harness and its account and
 * model, the folder and what opens it ("Open in").
 */
export function EnvironmentSection({ facts }: { facts: TabFacts }) {
  return (
    <InfoSection id="environment" title="Environment">
      <EnvironmentRows facts={facts} />
    </InfoSection>
  );
}

function EnvironmentRows({ facts }: { facts: TabFacts }) {
  const computer = useComputerName() ?? 'This Mac';
  const folder = folderLine(facts);
  const readOnly = policyLine(facts.session);
  return (
    <>
      <InfoRow icon={<Laptop size={ICON_SIZE} />} label={computer} />
      <HarnessRow session={facts.session} />
      {folder?.kind === 'removed' && (
        <InfoRow
          icon={<FolderGit2 size={ICON_SIZE} />}
          label="Worktree removed, rebuilt when the session next starts"
          tone="muted"
        />
      )}
      {folder?.kind === 'folder' && (
        <>
          <FolderRow line={folder} checkout={facts.checkout} />
          <OpenInButton folder={folder.path} />
        </>
      )}
      {readOnly && <InfoRow icon={<Lock size={ICON_SIZE} />} label={readOnly} />}
    </>
  );
}

/**
 * The harness the session runs under, the account it is signed in as and
 * the session's model. It reads what is already known, the harness's health
 * and the capabilities cache, and never asks the CLI itself.
 */
function HarnessRow({ session }: { session: Session }) {
  // Resolved as a launch resolves it, archived harnesses and legacy sessions included.
  const harness = useHarnessStore(
    (state) =>
      state.harnesses.find((candidate) => candidate.id === session.harnessId) ??
      state.harnesses.find((candidate) => candidate.isBuiltIn),
  );
  const healthAccount = useHarnessStore((state) =>
    harness ? state.statuses[harness.id]?.account : undefined,
  );
  const entry = useHarnessCapabilitiesStore((state) =>
    harness ? state.get(harness.id) : undefined,
  );
  const capabilities = entry && readCapabilities(entry);
  const driver = getDriverDescriptor(harness?.driverId);
  const line = harnessLine({
    driverLabel: driver.label,
    harnessName: harness?.name,
    signature: harness && launchSignature(toLaunchFields(harness)),
    answer: capabilities && {
      signature: entry?.signature,
      account: capabilities.account,
      models: capabilities.models,
    },
    healthAccount,
    model: session.model,
  });
  const title = [
    line.label,
    line.account && `signed in as ${line.account}`,
    line.model && `model ${line.model}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <InfoRow
      icon={<HarnessIcon driverId={driver.id} decorative />}
      label={
        <>
          {line.label}
          {line.account && <span className="info-row-muted"> {line.account}</span>}
        </>
      }
      value={line.model}
      title={title}
    />
  );
}

/**
 * The folder the session works in: what git says it is, then its path with
 * home as `~`, cut in the middle so its end stays whole. Clicking copies the
 * path: the next thing anyone does with a worktree is usually `cd` into it
 * from somewhere else.
 *
 * A checkout's row explains itself in a card, on hover or keyboard focus
 * (`CheckoutCard`), and then has no native title, so two never show at once.
 * A folder outside git, or one git has not answered for yet, keeps the title.
 * The card opens to the row's left, over the conversation, so it never covers
 * the row or the panel's other rows.
 *
 * "Copied" is said of the path that was copied, so it never carries over to
 * another session's folder, or to where the agent moved. And a card git
 * answers for while the pointer already rests on the row opens after the
 * same delay a hover waits, never at once, and not at all once the pointer
 * has left.
 */
function FolderRow({
  line,
  checkout,
}: {
  line: Extract<FolderLine, { kind: 'folder' }>;
  checkout: CheckoutInfo | undefined;
}) {
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  // What the pointer or the keyboard asked for, whether or not there is a card yet.
  const [cardOpen, setCardOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const copied = copiedPath === line.path;

  useEffect(() => {
    if (copiedPath === null) return;
    const timer = setTimeout(() => setCopiedPath(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copiedPath]);

  const shown = tildePath(line.path);
  const [head, tail] = splitForMiddle(shown, PATH_TAIL);
  const card = checkout && checkout.kind !== 'none' ? checkout : undefined;
  const cardReady = useHeldFor(card !== undefined, CARD_DELAY_MS);
  const cardShown = card !== undefined && cardReady && cardOpen;
  // Radix asks to open while there is no card yet, and never takes it back:
  // when the pointer leaves, it only clears its open timer (its card closes
  // on leaving the card's grace area, which a card not drawn has none of),
  // and on blur its close of a card that is not open changes nothing, so it
  // never says so. The pointer or the keyboard leaving the row takes the ask
  // back, or a late answer from git would open a card nobody points at.
  const withdraw = () => {
    if (!cardShown) setCardOpen(false);
  };
  const isWorktree = line.label === 'Worktree';
  const icon = isWorktree ? (
    <FolderGit2 size={ICON_SIZE} className="info-icon-worktree" />
  ) : (
    <Folder size={ICON_SIZE} />
  );
  const copy = () => {
    const copiedNow = line.path;
    navigator.clipboard.writeText(copiedNow).then(
      () => {
        setCopiedPath(copiedNow);
        // The row's own pointer-down closes the card; reopen it so the
        // confirmation is seen where the click happened, but only while the
        // pointer or the keyboard is still on the row: a card opened after
        // the pointer left has no grace area to close it by.
        const row = rowRef.current;
        if (row && (row.matches(':hover') || row === document.activeElement)) {
          setCardOpen(true);
        }
      },
      () => {
        // Clipboard refused (no focus); the card or title keeps offering the copy.
      },
    );
  };

  // One trigger whatever the folder is, so the row is never remounted (and
  // its keyboard focus lost) when git answers or the agent moves.
  return (
    <Tooltip.Provider delayDuration={CARD_DELAY_MS}>
      <Tooltip.Root open={cardShown} onOpenChange={setCardOpen}>
        <Tooltip.Trigger asChild ref={rowRef} onPointerLeave={withdraw} onBlur={withdraw}>
          <InfoRow
            icon={icon}
            label={
              <span className="info-folder">
                {line.label && <span className="info-folder-kind">{line.label}</span>}
                <span className="info-folder-path">
                  <span className="info-folder-path-head">{head}</span>
                  <span className="info-folder-path-tail">{tail}</span>
                </span>
              </span>
            }
            title={
              card
                ? undefined
                : `${shown}\n${copied ? 'Copied the folder path' : 'Click to copy the folder path'}`
            }
            ariaLabel={`${line.label ? `${line.label} ` : ''}${shown}. Copy folder path`}
            onActivate={copy}
          />
        </Tooltip.Trigger>
        {card && (
          <Tooltip.Portal>
            <Tooltip.Content
              className="tooltip-content checkout-tooltip"
              side="left"
              align="start"
              sideOffset={6}
              collisionPadding={8}
            >
              <CheckoutCard checkout={card} folder={line.path} copied={copied} />
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        )}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/**
 * True once `value` has held for `ms`, and false again the moment it does
 * not: a card that comes to exist waits as long as a hover would.
 */
function useHeldFor(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!value) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value && held;
}

/**
 * What the Folder row's card says about a checkout. A repository's own
 * checkout is the folder you opened. A linked worktree spells out the three
 * things people mix up, the branch, the worktree's folder and the main
 * checkout it belongs to, as labelled rows, because the folder name is
 * generated and never matches the branch.
 *
 * Its Folder is the session's own (`folder`), the path the row copies, even
 * where that is below the checkout's top.
 */
function CheckoutCard({
  checkout,
  folder,
  copied,
}: {
  checkout: Exclude<CheckoutInfo, { kind: 'none' }>;
  folder: string;
  copied: boolean;
}) {
  const isWorktree = checkout.kind === 'worktree';
  return (
    <>
      <span className="checkout-tooltip-title" data-kind={checkout.kind}>
        {isWorktree ? 'Worktree' : 'Main checkout'}
      </span>
      <p className="checkout-tooltip-lead">
        {isWorktree ? (
          <>
            A second working folder for <strong>{basename(checkout.mainCheckout)}</strong>, on its
            own branch. Edits here don't change the files in your main checkout.
          </>
        ) : (
          <>This session works directly in the folder you opened, not in a worktree.</>
        )}
      </p>
      <dl className="checkout-tooltip-facts">
        <dt>Branch</dt>
        <dd>
          <span className="checkout-tooltip-value">
            <GitBranch size={12} aria-hidden="true" />
            {checkout.branch ?? `none, detached at ${checkout.head ?? 'HEAD'}`}
          </span>
        </dd>
        <dt>Folder</dt>
        <dd>
          <span className="checkout-tooltip-value" data-kind={checkout.kind}>
            {isWorktree ? (
              <FolderGit2 size={12} aria-hidden="true" />
            ) : (
              <Folder size={12} aria-hidden="true" />
            )}
            {tildePath(folder)}
          </span>
          {isWorktree && (
            <span className="checkout-tooltip-note">
              Named by Consola, not after the branch, which can change inside it.
            </span>
          )}
        </dd>
        {isWorktree && (
          <>
            <dt>Main checkout</dt>
            <dd>
              <span className="checkout-tooltip-value">
                <Folder size={12} aria-hidden="true" />
                {tildePath(checkout.mainCheckout)}
              </span>
              <span className="checkout-tooltip-note">
                The folder you opened. Same repository: it shares commits and branches with this
                worktree.
              </span>
            </dd>
          </>
        )}
      </dl>
      <span className="checkout-tooltip-hint" data-copied={copied || undefined}>
        {copied ? 'Copied the folder path' : 'Click to copy the folder path'}
      </span>
    </>
  );
}
