import type { Harness } from '../../shared/harness';
import type { HarnessDriverId } from '../../shared/types';
import type { Session } from '../../shared/workspace';
import { getDriver, toHarnessConfig, type HarnessDriver } from '../drivers';
import { launchFieldsFor } from '../SessionLauncher';

/**
 * A session's last replies, read where its own harness keeps transcripts.
 *
 * `null` only when that harness's driver cannot read transcripts at all. A
 * driver that can, but finds none yet (a session before its first turn), has
 * nothing to report, `[]`, so the Assistant is never told a readable
 * harness is unreadable.
 */
export async function recentRepliesFor(
    harness: Harness | undefined,
    session: Session,
    count: number,
    driverFor: (id?: HarnessDriverId) => HarnessDriver = getDriver
): Promise<string[] | null> {
    const fields = launchFieldsFor(harness);
    const driver = driverFor(fields.driverId);
    if (!driver.getRecentReplies) return null;
    return (await driver.getRecentReplies(toHarnessConfig(fields), session.claudeSessionId, count)) ?? [];
}
