/** The Assistant's approval tray, per workspace: hidden by the person, and which requests it has shown. */
export interface TrayState {
  hidden: boolean;
  known: string[];
}

/**
 * The tray after the waiting requests change. Hiding it holds only until
 * something it has not shown arrives: a new request is news, and the tray is
 * where it is answered.
 */
export function nextTrayState(prev: TrayState | undefined, waitingIds: readonly string[]): TrayState {
  const anyNew = waitingIds.some((id) => !prev?.known.includes(id));
  return { hidden: anyNew ? false : (prev?.hidden ?? false), known: [...waitingIds] };
}

export function sameTrayState(a: TrayState | undefined, b: TrayState): boolean {
  return Boolean(a) && a!.hidden === b.hidden && a!.known.length === b.known.length && a!.known.every((id, index) => id === b.known[index]);
}
