/**
 * Finds the sessions whose pass t3 still keeps though no page shows them.
 *
 * t3 keeps a host's pass in its IndexedDB catalog while the host is registered and deletes it
 * only when the registration is removed. A page that closes or reloads without unmounting its
 * chats never removes them, and t3 has no list of the passes it keeps. So:
 *
 * - each page records the sessions it registers, one `localStorage` key per session
 *   (`consola-agent-ui:session:<id>`; the id only, never the pass), and holds a Web Lock of the
 *   same name, shared, from before it registers a session until t3 has removed it;
 * - at the first registration in a page, every recorded session whose lock nobody holds is one
 *   no page shows: holding its lock, the page removes what t3 keeps for it and drops the record.
 *
 * A lock goes with its page however the page ends, so a window still showing a session keeps its
 * pass, and a window that starts showing one waits until the removal is done.
 */
const RECORD_PREFIX = 'consola-agent-ui:session:';
const nameFor = (sessionId: string) => `${RECORD_PREFIX}${sessionId}`;

/** Web Locks, where the page has them (a secure context). */
const locks = (): LockManager | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.locks;

const recordedSessions = (): string[] => {
  const sessions: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(RECORD_PREFIX)) sessions.push(key.slice(RECORD_PREFIX.length));
  }
  return sessions;
};

/** How many holds this page has on each session. */
const ownHolds = new Map<string, number>();

/**
 * Whether a page other than this one holds the session: its lock is held more times than this
 * page holds it. Without Web Locks nothing tells, so false.
 */
export const heldByAnotherPage = async (sessionId: string): Promise<boolean> => {
  const manager = locks();
  if (manager === undefined) return false;
  const { held = [] } = await manager.query();
  const holds = held.filter(({ name }) => name === nameFor(sessionId)).length;
  return holds > (ownHolds.get(sessionId) ?? 0);
};

let recordFailureLogged = false;

/**
 * Records a session the page shows. Storage that refuses (full, or turned off) costs only the
 * record, never the chat: the session is then not found by a later page, so a pass this page
 * never removes stays in t3's catalog. Logged once per page.
 */
const record = (sessionId: string) => {
  try {
    localStorage.setItem(nameFor(sessionId), '');
  } catch (error) {
    if (recordFailureLogged) return;
    recordFailureLogged = true;
    console.warn(
      '@consola/agent-ui: could not record a session in localStorage, so a page that closes ' +
        "without unmounting its chat leaves its pass in t3's catalog.",
      error instanceof Error ? error.message : String(error),
    );
  }
};

/**
 * Holds a session for this page: resolves once no page is removing its pass and it is recorded
 * (`record`), with the function that lets it go (call it once t3 has removed the registration).
 */
export const holdSession = (sessionId: string): Promise<() => void> => {
  const manager = locks();
  if (manager === undefined) {
    record(sessionId);
    return Promise.resolve(() => {});
  }
  const count = (change: number) =>
    ownHolds.set(sessionId, (ownHolds.get(sessionId) ?? 0) + change);
  return new Promise((held, failed) => {
    let release: () => void = () => {};
    const released = new Promise<void>((done) => {
      release = done;
    });
    manager
      .request(nameFor(sessionId), { mode: 'shared' }, () => {
        record(sessionId);
        count(1);
        held(release);
        return released.finally(() => count(-1));
      })
      .catch(failed);
  });
};

/**
 * Forgets every recorded session no page holds, with `forget` (which removes what t3 keeps for
 * it), and drops its record. A session `forget` fails for keeps its record, so a later page
 * tries again; the failures are returned. Without Web Locks nothing is forgotten: there is no
 * telling whether another window shows the session.
 */
export const forgetUnheldSessions = async (
  forget: (sessionId: string) => Promise<void>,
): Promise<ReadonlyArray<{ readonly sessionId: string; readonly error: unknown }>> => {
  const manager = locks();
  if (manager === undefined) return [];
  const failures: Array<{ sessionId: string; error: unknown }> = [];
  for (const sessionId of recordedSessions()) {
    await manager.request(nameFor(sessionId), { ifAvailable: true }, async (lock) => {
      if (lock === null) return;
      try {
        await forget(sessionId);
        localStorage.removeItem(nameFor(sessionId));
      } catch (error) {
        failures.push({ sessionId, error });
      }
    });
  }
  return failures;
};
