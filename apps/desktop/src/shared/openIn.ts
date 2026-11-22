/**
 * "Open in": the apps on this computer a session's folder can be opened in,
 * as main found them (`main/openIn/`). Main decides what is installed and
 * opens only what it found; the renderer shows the list and asks.
 */

/** One app a folder can be opened in, as main found it. */
export interface OpenInTarget {
  /** Main's own id for the app (`vscode`, `finder`), the one `open` names. */
  id: string;
  /** The app's name, as the menu writes it. */
  label: string;
  /**
   * The file manager (Finder on a Mac), always offered: the favourite until
   * the person picks another, and again once theirs is no longer installed.
   */
  kind: 'file-manager' | 'app';
  /** The app's own icon, as a data URL; absent when it could not be read. */
  icon?: string;
}

export interface OpenInRequest {
  targetId: string;
  /** The folder, as an absolute path. */
  path: string;
}

/** What main said of an open: done, or why not, in a sentence it wrote. */
export type OpenInResult = { ok: true } | { ok: false; error: string };

/** What the preload exposes as `window.openInAPI`. Reach it through `openInBridge`. */
export interface OpenInAPI {
  /**
   * The apps found on this computer, the file manager last. Answered from
   * main's cache once it has one, which each call then refreshes behind
   * the answer.
   */
  list: () => Promise<OpenInTarget[]>;
  open: (request: OpenInRequest) => Promise<OpenInResult>;
}
