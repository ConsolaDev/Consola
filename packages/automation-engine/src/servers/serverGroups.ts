/**
 * The process groups Check server started, kept in a file of its own
 * (`mcp-server-groups.json`) from the moment each exists until it is ended,
 * so a quit or a crash mid-check leaves a group the next start ends. A
 * `uses:` step's group is on its step's record instead (`call.server`).
 */
import type { ServerGroup, StateFile } from '../ports';

export interface ServerGroupsFile {
  version: 1;
  /** `for`: what started it (`<workspace>/<automation>/<server>`); `at`: when (ISO). */
  groups: Array<ServerGroup & { for: string; at: string }>;
}

export class ServerGroupLedger {
  constructor(private readonly file: StateFile<ServerGroupsFile> | undefined) {}

  /** Written before the connect goes on: a write that throws fails it, and the adapter ends what it spawned. */
  public add(group: ServerGroup, forWhat: string, at: string): void {
    if (!this.file) return;
    const groups = this.groups();
    groups.push({ pgid: group.pgid, startedAt: group.startedAt, for: forWhat, at });
    this.file.write({ version: 1, groups });
  }

  public remove(group: ServerGroup): void {
    if (!this.file) return;
    const groups = this.groups();
    const kept = groups.filter(
      (entry) => !(entry.pgid === group.pgid && entry.startedAt === group.startedAt),
    );
    if (kept.length !== groups.length) this.file.write({ version: 1, groups: kept });
  }

  /** What an earlier start left: every group still listed. */
  public all(): ServerGroup[] {
    return this.groups().map(({ pgid, startedAt }) => ({ pgid, startedAt }));
  }

  /** The groups the file lists; none when it does not read, which is logged. */
  private groups(): ServerGroupsFile['groups'] {
    if (!this.file) return [];
    try {
      const read = this.file.read();
      return Array.isArray(read?.groups)
        ? read.groups.filter(
            (entry) => Number.isSafeInteger(entry?.pgid) && typeof entry?.startedAt === 'string',
          )
        : [];
    } catch (error) {
      console.error('Could not read the servers Check server started.', error);
      return [];
    }
  }
}
