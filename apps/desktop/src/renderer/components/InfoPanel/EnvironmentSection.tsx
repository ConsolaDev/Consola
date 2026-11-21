import { useEffect, useState } from 'react';
import { Folder, FolderGit2, Laptop, Lock } from 'lucide-react';
import { getDriverDescriptor } from '../../../shared/constants';
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
  readCapabilities,
  useHarnessCapabilitiesStore,
} from '../../stores/harnessCapabilitiesStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { tildePath } from '../../utils/displayPath';
import { HarnessIcon } from '../HarnessIcon';
import { InfoRow } from './InfoRow';
import { InfoSection } from './InfoSection';

/** How long "Copied the folder path" stays before the title explains again. */
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
      {folder?.kind === 'folder' && <FolderRow line={folder} />}
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
  const capabilities = useHarnessCapabilitiesStore((state) =>
    harness ? readCapabilities(state.get(harness.id)) : undefined,
  );
  const driver = getDriverDescriptor(harness?.driverId);
  const line = harnessLine({
    driverLabel: driver.label,
    harnessName: harness?.name,
    capabilityAccount: capabilities?.account,
    healthAccount,
    model: session.model,
    models: capabilities?.models,
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
 * path, as the header's checkout chip does.
 */
function FolderRow({ line }: { line: Extract<FolderLine, { kind: 'folder' }> }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const shown = tildePath(line.path);
  const [head, tail] = splitForMiddle(shown, PATH_TAIL);
  const isWorktree = line.label === 'Worktree';
  const icon = isWorktree ? (
    <FolderGit2 size={ICON_SIZE} className="info-icon-worktree" />
  ) : (
    <Folder size={ICON_SIZE} />
  );
  const copy = () => {
    navigator.clipboard.writeText(line.path).then(
      () => setCopied(true),
      () => {
        // Clipboard refused (no focus); the title keeps offering the copy.
      },
    );
  };

  return (
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
      title={`${shown}\n${copied ? 'Copied the folder path' : 'Click to copy the folder path'}`}
      ariaLabel={`${line.label ? `${line.label} ` : ''}${shown}. Copy folder path`}
      onActivate={copy}
    />
  );
}
