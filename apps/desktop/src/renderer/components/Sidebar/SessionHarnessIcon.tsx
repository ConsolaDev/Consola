import type { CSSProperties } from 'react';
import { HarnessIcon } from '../HarnessIcon';
import { getDriverDescriptor } from '../../../shared/constants';
import { useHarnessStore } from '../../stores/harnessStore';
import { harnessInitials } from '../../utils/harnessMark';

/**
 * Which harness a session runs under: the driver's mark, and beside it the
 * harness's initials in its own accent colour ("CW" for "Claude - Work").
 *
 * The initials are what tell two profiles of the same CLI apart, so they only
 * appear once there is more than one harness to tell apart. With one, the
 * mark alone says everything and a letter on every row would be noise.
 */
export function SessionHarnessIcon({
  harnessId,
  initials: when = 'several',
}: {
  harnessId: string | undefined;
  /**
   * When the initials appear: once there is more than one harness, or only
   * when another harness runs the same CLI — the one case the mark alone
   * cannot tell apart, and the only one a one-line row spends width on.
   */
  initials?: 'several' | 'same-cli';
}) {
  // Match launch resolution, including archived harnesses and legacy sessions.
  const harness = useHarnessStore(
    (state) =>
      state.harnesses.find((candidate) => candidate.id === harnessId) ??
      state.harnesses.find((candidate) => candidate.isBuiltIn),
  );
  const several = useHarnessStore((state) =>
    when === 'same-cli'
      ? state.harnesses.some(
          (candidate) => candidate.id !== harness?.id && candidate.driverId === harness?.driverId,
        )
      : state.harnesses.length > 1,
  );
  const driver = getDriverDescriptor(harness?.driverId);
  const label = harness ? `${driver.label} · ${harness.name}` : driver.label;
  const shownInitials = several && harness ? harnessInitials(harness.name) : '';

  return (
    <span
      className="session-harness-mark"
      style={
        shownInitials ? ({ '--harness-accent': harness!.accentColor } as CSSProperties) : undefined
      }
    >
      <HarnessIcon driverId={driver.id} label={label} className="session-nav-item-harness" />
      {shownInitials && (
        <span className="session-harness-initials" aria-hidden="true">
          {shownInitials}
        </span>
      )}
    </span>
  );
}
