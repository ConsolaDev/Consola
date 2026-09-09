import { HarnessIcon } from '../HarnessIcon';
import { getDriverDescriptor } from '../../../shared/constants';
import { useHarnessStore } from '../../stores/harnessStore';

export function SessionHarnessIcon({ harnessId }: { harnessId: string | undefined }) {
  // Match launch resolution, including archived harnesses and legacy sessions.
  const harness = useHarnessStore((state) =>
    state.harnesses.find((candidate) => candidate.id === harnessId)
      ?? state.harnesses.find((candidate) => candidate.isBuiltIn)
  );
  const driver = getDriverDescriptor(harness?.driverId);
  const label = harness ? `${driver.label} · ${harness.name}` : driver.label;

  return (
    <HarnessIcon
      driverId={driver.id}
      label={label}
      className="session-nav-item-harness"
    />
  );
}
