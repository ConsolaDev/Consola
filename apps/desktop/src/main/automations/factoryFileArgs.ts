/*
 * The arguments the renderer hands the factory-file intents (open a file,
 * check again, an entry's agents), checked in main before anything reaches
 * the engine or becomes a path: nothing but strings, and a file only as a
 * string or absent (absent is factory.yml).
 */

export function workspaceArg(workspaceId: unknown): string {
  if (typeof workspaceId !== 'string') throw new Error('Workspace id required.');
  return workspaceId;
}

export function entryArgs(
  workspaceId: unknown,
  name: unknown,
): { workspaceId: string; name: string } {
  if (typeof workspaceId !== 'string' || typeof name !== 'string') {
    throw new Error('Workspace id and automation name required.');
  }
  return { workspaceId, name };
}

export function openFileArgs(
  workspaceId: unknown,
  file: unknown,
): { workspaceId: string; file: string | undefined } {
  const checked = workspaceArg(workspaceId);
  if (file !== undefined && typeof file !== 'string') {
    throw new Error(`Not a file of this factory: \`${String(file)}\`.`);
  }
  return { workspaceId: checked, file };
}
