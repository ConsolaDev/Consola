import { describe, expect, it } from 'vitest';
import { entry } from './entryFixtures';
import { startedWorking } from './workingStarts';

describe('a row that starts working', () => {
  it('counts when a row moves into working from anything else', () => {
    for (const was of ['ready', 'done', 'exited', 'needs-attention', 'settled'] as const) {
      expect(startedWorking([entry('a', 'working')], [entry('a', was)])).toBe(true);
    }
  });

  it('counts a row that had no attention before', () => {
    expect(startedWorking([entry('a', 'working')], [])).toBe(true);
  });

  it('does not count a row that was already working', () => {
    expect(startedWorking([entry('a', 'working'), entry('b', 'ready')], [entry('a', 'working'), entry('b', 'ready')])).toBe(false);
  });

  it('does not count a row that stopped', () => {
    expect(startedWorking([entry('a', 'done')], [entry('a', 'working')])).toBe(false);
  });

  it('only looks at the rows it is given, so a hidden row starting work does not count', () => {
    // `now` is the list after filtering; `b` is not on it.
    expect(startedWorking([entry('a', 'ready')], [entry('a', 'ready'), entry('b', 'ready')])).toBe(false);
  });
});
