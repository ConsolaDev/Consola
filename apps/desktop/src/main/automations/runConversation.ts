import type { RunRecord } from '@consola/factory-spec';
import type { RunConversation } from '../../shared/conversation';
import type { Harness } from '../../shared/harness';
import type { HarnessDriverId } from '../../shared/types';
import type { Session } from '../../shared/workspace';
import { getDriver, toHarnessConfig, type HarnessDriver } from '../drivers';
import { launchFieldsFor } from '../SessionLauncher';

export interface RunConversationDeps {
    /** Every harness record, archived ones included. */
    harnesses(): Harness[];
    sessions(workspaceId: string): Session[];
    driverFor?: (id?: HarnessDriverId) => HarnessDriver;
}

/**
 * What the side panel shows of a run's conversation, read from the transcript
 * on disk — never by starting or resuming anything.
 *
 * The run's own window is from its start to its finish (open-ended while it
 * runs): a session can carry on past the run. A run from before runs
 * recorded their conversation falls back to its session, if that still exists.
 */
export async function readRunConversation(run: RunRecord, deps: RunConversationDeps): Promise<RunConversation> {
    let pointer = run.conversation && { harnessId: run.conversation.harnessId, id: run.conversation.id };
    if (!pointer && run.sessionId && run.attribution.workspaceId) {
        const session = deps
            .sessions(run.attribution.workspaceId)
            .find((candidate) => candidate.id === run.sessionId);
        if (session) pointer = { harnessId: session.harnessId, id: session.claudeSessionId };
    }
    if (!pointer) return { readable: false };

    const harness = deps.harnesses().find((candidate) => candidate.id === pointer.harnessId);
    const fields = launchFieldsFor(harness);
    const driver = (deps.driverFor ?? getDriver)(fields.driverId);
    if (!driver.readConversation) return { readable: false };

    const conversation = await driver.readConversation(toHarnessConfig(fields), pointer.id, {
        since: run.startedAt ?? run.createdAt,
        until: run.finishedAt,
    });
    return { readable: true, conversation };
}
