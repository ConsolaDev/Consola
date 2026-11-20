import { useEffect, type CSSProperties } from 'react';
import { getDriverDescriptor } from '../../../shared/constants';
import { HarnessIcon } from '../HarnessIcon';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import {
  isSelectableHarness,
  useHarnessStore,
  type Harness,
  type HarnessStatus,
} from '../../stores/harnessStore';

interface HarnessPanelProps {
  workspace: Workspace;
}

/**
 * Who a harness is signed in as, or why it cannot run — the one fact that
 * tells two profiles of the same CLI apart. Nothing until a probe answers,
 * so a row never claims something it has not checked.
 */
function describeIdentity(
  status: HarnessStatus | undefined,
): { text: string; unavailable: boolean; detail?: string } | null {
  if (!status || status.state === 'unknown' || status.state === 'probing') return null;
  if (status.state === 'error') {
    return { text: 'Unavailable', unavailable: true, detail: status.error };
  }
  const identity = status.account?.emailAddress ?? status.account?.displayName;
  return { text: identity ?? 'Not signed in', unavailable: false };
}

/**
 * The workspace's default harness — preselected when a conversation starts
 * here. One already-confirming click, so choosing commits immediately, the
 * same way the WorkspaceSwitcher's submenu always has.
 *
 * Each row's accent dot is its radio: the harness's own colour fills it when
 * chosen, so the selection reads in the colour the sidebar already uses for
 * that harness rather than a second, unrelated highlight.
 */
export function HarnessPanel({ workspace }: HarnessPanelProps) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const harnesses = useHarnessStore((state) => state.harnesses);
  const statuses = useHarnessStore((state) => state.statuses);
  const probeHarness = useHarnessStore((state) => state.probeHarness);
  const selectable = harnesses.filter(isSelectableHarness);

  // Health is a version check and a read of the profile, never the
  // capabilities probe (that one runs the user's hooks). Only harnesses no one
  // has checked yet are asked, so reopening settings costs nothing.
  useEffect(() => {
    const known = useHarnessStore.getState().statuses;
    for (const harness of harnesses.filter(isSelectableHarness)) {
      if (!known[harness.id]) void probeHarness(harness);
    }
  }, [harnesses, probeHarness]);

  const choose = (harness: Harness) =>
    void updateWorkspace(workspace.id, { defaultHarnessId: harness.id });

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title" id={`ws-harness-title-${workspace.id}`}>
          Default harness
        </h3>
      </div>
      <p className="ws-panel-hint">
        Preselected when starting a conversation in this workspace. Existing sessions keep the
        harness they started on.
      </p>
      <div
        className="ws-harness-list"
        role="radiogroup"
        aria-labelledby={`ws-harness-title-${workspace.id}`}
      >
        {selectable.map((harness) => {
          const isDefault = harness.id === workspace.defaultHarnessId;
          const identity = describeIdentity(statuses[harness.id]);
          return (
            <label
              key={harness.id}
              className={`ws-harness-option ${isDefault ? 'selected' : ''}`}
              style={{ '--harness-accent': harness.accentColor } as CSSProperties}
            >
              <input
                type="radio"
                className="ws-harness-input"
                name={`ws-default-harness-${workspace.id}`}
                value={harness.id}
                checked={isDefault}
                onChange={() => choose(harness)}
              />
              <span className="ws-harness-radio" aria-hidden="true" />
              <span className="ws-harness-text">
                <span className="ws-harness-name">{harness.name}</span>
                <span className="ws-harness-meta">
                  <HarnessIcon driverId={harness.driverId} decorative />
                  <span>{getDriverDescriptor(harness.driverId).label}</span>
                  {identity && (
                    <span
                      className={`ws-harness-identity ${identity.unavailable ? 'unavailable' : ''}`}
                      title={identity.detail}
                    >
                      {identity.text}
                    </span>
                  )}
                </span>
              </span>
              <span className="ws-harness-hint" aria-hidden="true">
                Set as default
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
