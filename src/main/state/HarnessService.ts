import { JsonStateFile } from './JsonStateFile';
import { BUILT_IN_HARNESS_ID } from '../../shared/constants';
import {
    createBuiltInHarness,
    type Harness,
    type HarnessUpdates,
    type NewHarnessFields,
} from '../../shared/harness';

export interface HarnessStateFile {
    version: number;
    harnesses: Harness[];
}

const HARNESS_STATE_VERSION = 1;

/**
 * The single writer for harness records.
 *
 * A harness never holds a credential — it is a launch description — but the
 * record still has to outlive its own removal, because a session's transcript
 * lives in the config directory the harness names and `--resume` only finds it
 * there. That is why archiving exists and deletion does not.
 */
export class HarnessService {
    private harnesses: Harness[] = [];
    /**
     * Whether state has ever been established — loaded from disk, or written.
     *
     * Not "is the collection empty": an empty list that has been committed is
     * still state, and a one-time import that replaced it would be data loss.
     */
    private established = false;
    private readonly listeners = new Set<(harnesses: Harness[]) => void>();

    constructor(private readonly file: JsonStateFile<HarnessStateFile>) {}

    public load(): void {
        const stored = this.file.read();
        this.established = stored !== null;
        this.harnesses = stored ? this.withBuiltIn(stored.harnesses) : [createBuiltInHarness()];
    }

    public hasState(): boolean {
        return this.established;
    }

    public getAll(): Harness[] {
        return this.harnesses;
    }

    public importState(harnesses: Harness[]): boolean {
        if (this.hasState()) return false;
        this.harnesses = this.withBuiltIn(harnesses);
        this.commit();
        return true;
    }

    public addHarness(input: NewHarnessFields): Harness {
        const now = Date.now();
        const harness: Harness = {
            enabled: true,
            extraArgs: [],
            ...input,
            archived: false,
            isBuiltIn: false,
            createdAt: now,
            updatedAt: now,
        };
        this.harnesses = [...this.harnesses, harness];
        this.commit();
        return harness;
    }

    public updateHarness(id: string, updates: HarnessUpdates): void {
        this.harnesses = this.harnesses.map((harness) =>
            harness.id === id ? { ...harness, ...updates, updatedAt: Date.now() } : harness
        );
        this.commit();
    }

    /**
     * Take a harness out of circulation without stranding its sessions.
     *
     * The built-in is exempt: it is what every session falls back to, and a
     * session whose harness resolves to nothing cannot launch at all.
     */
    public archiveHarness(id: string): void {
        if (id === BUILT_IN_HARNESS_ID) return;
        this.setArchived(id, true);
    }

    public restoreHarness(id: string): void {
        this.setArchived(id, false);
    }

    public onChange(listener: (harnesses: Harness[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private setArchived(id: string, archived: boolean): void {
        this.harnesses = this.harnesses.map((harness) =>
            harness.id === id ? { ...harness, archived, updatedAt: Date.now() } : harness
        );
        this.commit();
    }

    /** The built-in is always present, however the stored list arrived. */
    private withBuiltIn(harnesses: Harness[]): Harness[] {
        return harnesses.some((harness) => harness.id === BUILT_IN_HARNESS_ID)
            ? harnesses
            : [createBuiltInHarness(), ...harnesses];
    }

    private commit(): void {
        this.file.write({ version: HARNESS_STATE_VERSION, harnesses: this.harnesses });
        this.established = true;
        for (const listener of this.listeners) listener(this.harnesses);
    }
}
