import type { OpenInRequest, OpenInResult, OpenInTarget } from '../../shared/openIn';

/**
 * "Open in" a session's folder: the one place the renderer reaches
 * `window.openInAPI`. Main finds the apps and does the opening.
 */
export const openInBridge = {
  /** The apps on this computer a folder can be opened in, the file manager last. */
  list(): Promise<OpenInTarget[]> {
    return window.openInAPI.list();
  },

  /** Opens a folder in one of them: done, or main's sentence for why not. */
  open(request: OpenInRequest): Promise<OpenInResult> {
    return window.openInAPI.open(request);
  },
};
