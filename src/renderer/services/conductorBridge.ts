import type { ConductorCreateRequest } from '../../shared/types';
import type { Group } from '../../shared/workspace';

/**
 * Bridge to conductor orchestration owned by the main process.
 *
 * One intent: create. Main scaffolds the directory, creates the group, and
 * launches the conductor session; the renderer learns the rest through the
 * ordinary workspace-changed broadcast.
 */
export const conductorBridge = {
    create(request: ConductorCreateRequest): Promise<Group> {
        return window.conductorAPI.create(request);
    },
};
