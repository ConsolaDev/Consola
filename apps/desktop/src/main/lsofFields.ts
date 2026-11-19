/** One `n` field of `lsof -F`, with the process it belongs to. */
export interface LsofRecord {
  pid: number;
  /** The `c` field, or empty when the call did not ask for it. */
  command: string;
  /** The `n` field: a working directory under `-d cwd`, an address under `-i`. */
  name: string;
}

/**
 * Reads `lsof -F` output: a `p` line opens a process, `c` is its command and
 * each `n` line is one name it holds. A process with several names (a server
 * listening on IPv4 and IPv6) yields one record per name. Both the process
 * working-directory index and the local-server scan ask lsof this way, so the
 * format is read in one place.
 */
export function parseLsofFields(output: string): LsofRecord[] {
  const records: LsofRecord[] = [];
  let pid: number | null = null;
  let command = '';
  for (const line of output.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number.parseInt(value, 10);
      command = '';
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n' && pid !== null && Number.isFinite(pid)) {
      records.push({ pid, command, name: value });
    }
  }
  return records;
}
