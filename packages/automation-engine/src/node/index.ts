/**
 * The engine's Node adapters: the only files in the package that may import
 * `fs`, `os`, `child_process` and the like. `boundary.test.ts` enforces it.
 */
export { RunHistoryFiles } from './RunHistoryFiles';
export { JsonStateFile, StateFileCorruptError } from './JsonStateFile';
export { FactoryFile, workspaceDataDir, workspaceFactoryPath } from './factoryFile';
