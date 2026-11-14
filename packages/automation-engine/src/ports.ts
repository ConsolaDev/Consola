/** One persisted JSON document, read and written whole. The engine's stores take this; `node/JsonStateFile` is the disk-backed one. */
export interface StateFile<T> {
    read(): T | null;
    write(value: T): void;
}
