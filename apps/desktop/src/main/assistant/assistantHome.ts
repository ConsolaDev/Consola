import * as fs from 'fs';
import * as path from 'path';
import { workspaceDataDir } from '../automations/FactoryFile';
import { renderAssistantBrief } from './assistantBrief';

/** The Assistant's own folder, next to the workspace's `factory.yml`. Not a repository; no session works here. */
export function assistantFolder(workspaceId: string): string {
    return path.join(workspaceDataDir(workspaceId), 'assistant');
}

/**
 * Create the Assistant's folder and, the first time, its `CLAUDE.md` brief.
 * The brief is the person's to edit from then on, so it is written only when
 * absent (`wx`) and never refreshed — not even when the workspace is renamed.
 */
export async function ensureAssistantHome(workspaceId: string, workspaceName: string): Promise<string> {
    const dir = assistantFolder(workspaceId);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
        await fs.promises.writeFile(path.join(dir, 'CLAUDE.md'), renderAssistantBrief({ workspaceName }), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return dir;
}
