import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Git calls a file binary when a NUL appears within this many leading bytes. */
const BINARY_SNIFF_BYTES = 8000;
/** core.bigFileThreshold's default: past it, git diffs a file as binary. */
const BIG_FILE_BYTES = 512 * 1024 * 1024;
/** Enough to keep the disk busy without exhausting file descriptors. */
const CONCURRENCY = 16;
/** A hung git (a stale lock on a network drive) must not hold a header hostage. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Lines that untracked files would add, as `git diff --numstat` would count
 * them were the files tracked. `git diff` leaves untracked files out
 * entirely, so a checkout whose changes are mostly new files would otherwise
 * report a handful of lines against a list of hundreds of files.
 *
 * Paths are relative to `root`. One that cannot be read (deleted since git
 * listed it, a nested repository listed as its folder) counts as nothing.
 */
export async function countUntrackedLines(root: string, relativePaths: readonly string[]): Promise<number> {
  const marked = await markedBinary(root, relativePaths);
  const counted = relativePaths.filter((p) => !marked.has(p));
  let total = 0;
  let next = 0;
  const worker = async () => {
    while (next < counted.length) {
      // Not `total += await …`: that reads `total` before awaiting, so
      // workers finishing together would overwrite each other's sums.
      const lines = await linesInNewFile(path.join(root, counted[next++]));
      total += lines;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, counted.length) }, worker));
  return total;
}

/**
 * An untracked file as the review panel shows it, judged binary by the same
 * rules `countUntrackedLines` uses, so a file the header counts no lines for
 * never shows lines in the panel. Null when it cannot be read at all.
 */
export async function readUntrackedFile(
  root: string,
  relativePath: string
): Promise<{ content: string; isBinary: boolean } | null> {
  const file = path.join(root, relativePath);
  try {
    const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink()) return { content: await fs.promises.readlink(file), isBinary: false };
    const binary = { content: '', isBinary: true };
    if (stat.size > BIG_FILE_BYTES || (await markedBinary(root, [relativePath])).size > 0) return binary;
    const bytes = await fs.promises.readFile(file);
    return sniffsBinary(bytes) ? binary : { content: bytes.toString('utf-8'), isBinary: false };
  } catch {
    return null;
  }
}

function sniffsBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

async function linesInNewFile(file: string): Promise<number> {
  try {
    const stat = await fs.promises.lstat(file);
    // Git diffs a symlink as its target path: one line, whatever it points at.
    if (stat.isSymbolicLink()) return 1;
    if (!stat.isFile() || stat.size === 0 || stat.size > BIG_FILE_BYTES) return 0;

    let newlines = 0;
    let sniffed = 0;
    let lastByte = 0;
    for await (const chunk of fs.createReadStream(file)) {
      const bytes = chunk as Buffer;
      if (sniffed < BINARY_SNIFF_BYTES && sniffsBinary(bytes.subarray(0, BINARY_SNIFF_BYTES - sniffed))) return 0;
      sniffed += bytes.length;
      for (let i = bytes.indexOf(0x0a); i !== -1; i = bytes.indexOf(0x0a, i + 1)) newlines++;
      lastByte = bytes[bytes.length - 1];
    }
    return lastByte === 0x0a ? newlines : newlines + 1;
  } catch {
    return 0;
  }
}

/**
 * The paths .gitattributes keeps out of diffs (`binary`, `-diff`), which git
 * counts no lines for whatever they contain. One git process answers for all
 * of them. Should it fail, none are treated as marked: the count is then off
 * only for marked files, which is better than no count at all.
 */
function markedBinary(root: string, relativePaths: readonly string[]): Promise<Set<string>> {
  if (relativePaths.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', root, 'check-attr', '-z', '--stdin', 'diff'],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        const marked = new Set<string>();
        if (!err) {
          // -z output is <path> NUL <attribute> NUL <value> NUL, per path.
          const fields = stdout.split('\0');
          for (let i = 0; i + 2 < fields.length; i += 3) {
            if (fields[i + 2] === 'unset') marked.add(fields[i]);
          }
        }
        resolve(marked);
      }
    );
    // A git that exits before reading everything would fail the write.
    child.stdin?.on('error', () => {});
    child.stdin?.end(relativePaths.join('\0') + '\0');
  });
}
