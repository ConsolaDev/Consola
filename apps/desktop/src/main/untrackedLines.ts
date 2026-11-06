import * as fs from 'fs';
import * as path from 'path';

/** Git calls a file binary when a NUL appears within this many leading bytes. */
const BINARY_SNIFF_BYTES = 8000;
/** core.bigFileThreshold's default: past it, git diffs a file as binary. */
const BIG_FILE_BYTES = 512 * 1024 * 1024;
/** Enough to keep the disk busy without exhausting file descriptors. */
const CONCURRENCY = 16;

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
  let total = 0;
  let next = 0;
  const worker = async () => {
    while (next < relativePaths.length) {
      // Not `total += await …`: that reads `total` before awaiting, so
      // workers finishing together would overwrite each other's sums.
      const lines = await linesInNewFile(path.join(root, relativePaths[next++]));
      total += lines;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, relativePaths.length) }, worker));
  return total;
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
      if (sniffed < BINARY_SNIFF_BYTES && bytes.subarray(0, BINARY_SNIFF_BYTES - sniffed).includes(0)) return 0;
      sniffed += bytes.length;
      for (let i = bytes.indexOf(0x0a); i !== -1; i = bytes.indexOf(0x0a, i + 1)) newlines++;
      lastByte = bytes[bytes.length - 1];
    }
    return lastByte === 0x0a ? newlines : newlines + 1;
  } catch {
    return 0;
  }
}
