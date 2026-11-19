import * as fs from 'fs/promises';
import * as path from 'path';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Where a browser screenshot lives: `<root>/<session id>/<timestamp>.png`,
 * under Consola's own data folder, never in the repository where it would
 * show up as a change. The path is what gets pasted into the session, so the
 * agent reads the file itself; the image goes nowhere else. Gone with the
 * session (`SessionRemover`).
 */
export class CaptureStore {
  constructor(private readonly root: string) {}

  /** The file a capture taken at `at` is written to. */
  public pathFor(sessionId: string, at = new Date()): string {
    if (!SAFE_ID.test(sessionId)) throw new Error('Invalid session id.');
    // ":" and "." are awkward in a pasted path, so the timestamp avoids them.
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    return path.join(this.root, sessionId, `${stamp}.png`);
  }

  /** Writes a PNG and answers its absolute path. Owner-only, like a handoff. */
  public async write(sessionId: string, png: Buffer, at = new Date()): Promise<string> {
    const file = this.pathFor(sessionId, at);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, png, { mode: 0o600 });
    return file;
  }

  /** A session's captures, every one. Nothing to remove is not an error. */
  public async removeAll(sessionId: string): Promise<void> {
    if (!SAFE_ID.test(sessionId)) return;
    await fs.rm(path.join(this.root, sessionId), { recursive: true, force: true });
  }
}
