import * as fs from 'fs';
import * as path from 'path';

/**
 * Raised when neither the primary file nor its backup can be parsed.
 *
 * Deliberately not recoverable into empty state: zero workspaces is
 * indistinguishable from total data loss to the person looking at it, and it
 * would silently orphan every transcript on disk.
 */
export class StateFileCorruptError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Could not read ${filePath} or its backup: ${String(cause)}`);
    this.name = 'StateFileCorruptError';
  }
}

/**
 * A JSON file that survives an application-level crash mid-write.
 *
 * Writes go to a temp file, are flushed, and are renamed into place, so the
 * primary is either the old value or the new one and never a truncated mix.
 * The previous value is kept alongside as `.bak`, which is what makes a bad
 * primary recoverable instead of fatal.
 *
 * Does not protect against a hard power loss at the rename boundary, where the
 * filesystem may revert to the pre-write state. The trade-off is appropriate for
 * a desktop application.
 */
export class JsonStateFile<T> {
  private readonly backupPath: string;
  private readonly tempPath: string;

  constructor(private readonly filePath: string) {
    this.backupPath = `${filePath}.bak`;
    this.tempPath = `${filePath}.tmp`;
  }

  public exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * @returns The stored value, or null when nothing has ever been written.
   * @throws StateFileCorruptError when a file exists but nothing parses.
   */
  public read(): T | null {
    if (!fs.existsSync(this.filePath) && !fs.existsSync(this.backupPath)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as T;
    } catch (primaryError) {
      try {
        return JSON.parse(fs.readFileSync(this.backupPath, 'utf8')) as T;
      } catch {
        throw new StateFileCorruptError(this.filePath, primaryError);
      }
    }
  }

  public write(value: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (fs.existsSync(this.filePath) && this.isReadable(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }

    const handle = fs.openSync(this.tempPath, 'w');
    try {
      fs.writeFileSync(handle, JSON.stringify(value, null, 2), 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }

    fs.renameSync(this.tempPath, this.filePath);
  }

  /**
   * Whether a file on disk parses.
   *
   * Guards the backup copy. Promoting an unreadable primary into `.bak`
   * would destroy the last good copy at exactly the moment it becomes
   * load-bearing — a corrupt primary is when the backup is the only thing
   * standing between the user and an empty workspace list.
   */
  private isReadable(candidate: string): boolean {
    try {
      JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return true;
    } catch {
      return false;
    }
  }
}
