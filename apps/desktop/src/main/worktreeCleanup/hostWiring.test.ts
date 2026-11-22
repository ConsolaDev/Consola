import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * What main hands the cleanup, read from its one construction: a guard the
 * service's own tests cannot reach, since they build it with fakes. A run
 * parked at a gate holds its checkout with no process there and its sessions
 * settled, so the cleanup must ask the runner (3-A code review S1).
 */

const ipc = fs.readFileSync(path.resolve(__dirname, '../ipc-handlers.ts'), 'utf8');

/** The object literal `new WorktreeCleanupService({ … })` is given, to its closing `});`. */
function cleanupDeps(): string {
  const from = ipc.indexOf('new WorktreeCleanupService({');
  const to = ipc.indexOf('\n  });', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return ipc.slice(from, to);
}

describe("main's worktree cleanup", () => {
  it('is built once', () => {
    expect(ipc.match(/new WorktreeCleanupService\(/g)).toHaveLength(1);
  });

  it("asks the runner which checkouts its runs hold, through the tree's own resolution", () => {
    expect(cleanupDeps()).toMatch(
      /\n {4}runHolds: \(tree\) => treeHeldByRun\(tree, automations\.heldCheckouts\(\), worktrees\),\n/,
    );
  });
});
