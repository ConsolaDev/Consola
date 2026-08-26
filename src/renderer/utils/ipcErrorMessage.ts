/**
 * A rejected `ipcRenderer.invoke` wraps the main process's own message in
 * Electron's own prefix — `Error invoking remote method '<channel>': Error:
 * <message>` — which is meaningless to a user staring at an inline error.
 * Strip it back down to what main actually said; anything that isn't an
 * Error, or doesn't carry the prefix, is left as-is.
 */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/^Error invoking remote method '[^']*': (?:Error: )?([\s\S]*)$/);
  return match ? match[1] : raw;
}
