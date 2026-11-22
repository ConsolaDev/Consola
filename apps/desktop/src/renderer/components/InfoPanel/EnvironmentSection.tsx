import { useEffect, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Folder, FolderGit2, GitBranch, Laptop, Lock } from 'lucide-react';
import { getDriverDescriptor } from '../../../shared/constants';
import type { CheckoutInfo } from '../../../shared/sessionCheckout';
import type { Session } from '../../../shared/workspace';
import {
  folderLine,
  harnessLine,
  readOnlyLine,
  splitForMiddle,
  type FolderLine,
} from '../../infoPanel/environment';
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

/** How long "Copied the folder path" stays before the card or title explains again. */
const COPIED_MS = 1500;
/** How much of a folder's path is always drawn: its end, which tells worktrees apart. */
const PATH_TAIL = 14;

const ICON_SIZE = 14;

/** Where the session runs: the computer, the harness and its account and model, the folder. */
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
  const readOnly = readOnlyLine(facts.session);
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
      {folder?.kind === 'folder' && <FolderRow line={folder} checkout={facts.checkout} />}
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
 */
function FolderRow({
  line,
  checkout,
}: {
  line: Extract<FolderLine, { kind: 'folder' }>;
  checkout: CheckoutInfo | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const shown = tildePath(line.path);
  const [head, tail] = splitForMiddle(shown, PATH_TAIL);
  const card = checkout && checkout.kind !== 'none' ? checkout : undefined;
  const isWorktree = line.label === 'Worktree';
  const icon = isWorktree ? (
    <FolderGit2 size={ICON_SIZE} className="info-icon-worktree" />
  ) : (
    <Folder size={ICON_SIZE} />
  );
  const copy = () => {
    navigator.clipboard.writeText(line.path).then(
      () => {
        setCopied(true);
        // The row's own pointer-down closes the card; reopen it so the
        // confirmation is seen where the click happened.
        setCardOpen(true);
      },
      () => {
        // Clipboard refused (no focus); the card or title keeps offering the copy.
      },
    );
  };

  // One trigger whatever the folder is, so the row is never remounted (and
  // its keyboard focus lost) when git answers or the agent moves.
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root open={card !== undefined && cardOpen} onOpenChange={setCardOpen}>
        <Tooltip.Trigger asChild>
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
              <CheckoutCard checkout={card} copied={copied} />
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        )}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/**
 * What the Folder row's card says about a checkout. A repository's own
 * checkout is the folder you opened. A linked worktree spells out the three
 * things people mix up, the branch, the worktree's folder and the main
 * checkout it belongs to, as labelled rows, because the folder name is
 * generated and never matches the branch.
 */
function CheckoutCard({
  checkout,
  copied,
}: {
  checkout: Exclude<CheckoutInfo, { kind: 'none' }>;
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
            {tildePath(checkout.root)}
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
