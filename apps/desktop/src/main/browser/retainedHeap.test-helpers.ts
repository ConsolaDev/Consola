import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

/*
 * For tests only: how much of the heap what main keeps of a page's text
 * holds on to. A string cut from another can keep the whole of it alive, and
 * only the heap says whether it does.
 */

export const MB = 1024 * 1024;

/** V8's collector, which a test process does not have unless asked for. */
function collector(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

/**
 * How much more of the heap is in use once `keep` has been given twenty
 * fresh 5 MB strings, each dropped at once, and kept what it keeps of them:
 * about 100 MB if each kept piece still holds its whole string, a few
 * kilobytes if it holds only itself.
 */
export function retainedBy(keep: (text: string) => unknown): number {
  const gc = collector();
  gc();
  const before = getHeapStatistics().used_heap_size;
  const kept: unknown[] = [];
  for (let i = 0; i < 20; i++) {
    // Built afresh each time, as each debugger event is parsed afresh.
    kept.push(keep(String(i).padEnd(5 * MB, 'x')));
  }
  gc();
  const retained = getHeapStatistics().used_heap_size - before;
  if (kept.length !== 20) throw new Error('kept nothing');
  return retained;
}
