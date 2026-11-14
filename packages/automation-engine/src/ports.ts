import type { FactorySpecParseResult } from '@consola/factory-spec';

/** One persisted JSON document, read and written whole. The engine's stores take this; `node/JsonStateFile` is the disk-backed one. */
export interface StateFile<T> {
    read(): T | null;
    write(value: T): void;
}

export interface LoadedFactoryFile {
    exists: boolean;
    spec: FactorySpecParseResult;
}

/** One workspace's spec file. */
export interface FactoryFileHandle {
    readonly filePath: string;
    load(): Promise<LoadedFactoryFile>;
    watch(onChange: () => void): void;
    unwatch(): void;
    /** Create the file from `template` when it is missing; returns its path. */
    ensureExists(template: string): Promise<string>;
    /** Add one automation (a `- name: …` item) at the end of the list, keeping everything else. */
    appendAutomation(entryYaml: string): Promise<void>;
    /** Swap the automation called `name` for `entryYaml`, in place, keeping every byte outside it. */
    replaceAutomation(name: string, entryYaml: string): Promise<void>;
    /** The file as written, or null when there is none yet. */
    readText(): Promise<string | null>;
}
