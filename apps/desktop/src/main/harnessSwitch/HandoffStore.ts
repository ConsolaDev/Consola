import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Where handoff documents live: `<root>/<session id>/<time>-<harness id>.md`,
 * under Consola's own data folder — never in the repository, where they
 * would show up as changes.
 *
 * Keyed by the Consola session, not a conversation: a later handoff points
 * back at an earlier one, so every document lives as long as the session
 * does, and goes with it (`SessionRemover`). Written owner-only, since a
 * transcript can hold whatever was pasted into it.
 */
export class HandoffStore {
  constructor(private readonly root: string) {}

  /** Write a handoff and return its absolute path. Never leaves a partial file. */
  public async write(
    sessionId: string,
    fromHarnessId: string,
    markdown: string,
    at = new Date(),
  ): Promise<string> {
    if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(fromHarnessId))
      throw new Error('Invalid handoff name.');
    const directory = path.join(this.root, sessionId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(
      directory,
      `${at.toISOString().replace(/[:.]/g, '-')}-${fromHarnessId}.md`,
    );
    const partial = `${file}.${process.pid}.partial`;
    try {
      await fs.writeFile(partial, markdown, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(partial, file);
    } finally {
      await fs.rm(partial, { force: true });
    }
    return file;
  }

  /** A session's handoffs, every one. Nothing to remove is not an error. */
  public async removeAll(sessionId: string): Promise<void> {
    if (!SAFE_ID.test(sessionId)) return;
    await fs.rm(path.join(this.root, sessionId), { recursive: true, force: true });
  }
}
