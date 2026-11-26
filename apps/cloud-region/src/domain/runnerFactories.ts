import {
  FACTORIES_PER_ANSWER_MAX,
  FACTORY_FILE_PATH_MAX,
  FACTORY_FILE_TEXT_MAX,
  FILES_PER_FACTORY_MAX,
  SOCKET_FRAME_MAX_BYTES,
} from '@consola/runner-protocol';
import type { FactoriesAnswer, FactorySnapshot } from '@consola/runner-protocol';

/**
 * The cell's answer to a runner's `factories.request`: the factories it asked for, each at one
 * version with that version's files, in one message. The protocol bounds what one answer holds
 * (`FACTORIES_PER_ANSWER_MAX` factories of `FILES_PER_FACTORY_MAX` files), but a frame is the real
 * limit (`SOCKET_FRAME_MAX_BYTES`): both sides close the socket on a larger one. So the answer
 * takes whole factories, in the order given, while its JSON fits, and says which it left out and
 * why, for the cell to log. A factory is never sent in part: a runner would take its files for
 * the whole folder.
 */

/** Why a factory was left out of an answer. */
export type LeftOutReason =
  /** Its files alone, or with the factories before it, would not fit in one frame. */
  | 'too-large'
  /** The answer already held `FACTORIES_PER_ANSWER_MAX` factories. */
  | 'too-many'
  /** A file the protocol could not carry: too many, a path or a text past its bound. */
  | 'outside-the-protocol';

export type LeftOut = { factoryId: string; version: number; reason: LeftOutReason };

const utf8 = new TextEncoder();
const bytesOf = (value: unknown): number => utf8.encode(JSON.stringify(value)).length;

const fitsTheProtocol = (snapshot: FactorySnapshot): boolean =>
  snapshot.files.length <= FILES_PER_FACTORY_MAX &&
  snapshot.files.every(
    (file) =>
      file.path.length > 0 &&
      file.path.length <= FACTORY_FILE_PATH_MAX &&
      file.content.length <= FACTORY_FILE_TEXT_MAX,
  );

/**
 * The `factories` message for `requestId`, holding as many of `snapshots`, whole and in order, as
 * fit in `maxBytes` of JSON, and the ones left out.
 */
export function factoriesAnswer(
  requestId: string,
  snapshots: readonly FactorySnapshot[],
  maxBytes: number = SOCKET_FRAME_MAX_BYTES,
): { answer: FactoriesAnswer; left: LeftOut[] } {
  const factories: FactorySnapshot[] = [];
  const left: LeftOut[] = [];
  let size = bytesOf({ type: 'factories', requestId, factories: [] });
  for (const snapshot of snapshots) {
    const leave = (reason: LeftOutReason) =>
      left.push({ factoryId: snapshot.factoryId, version: snapshot.version, reason });
    if (!fitsTheProtocol(snapshot)) {
      leave('outside-the-protocol');
      continue;
    }
    if (factories.length === FACTORIES_PER_ANSWER_MAX) {
      leave('too-many');
      continue;
    }
    // A comma before every factory but the first.
    const added = bytesOf(snapshot) + (factories.length > 0 ? 1 : 0);
    if (size + added > maxBytes) {
      leave('too-large');
      continue;
    }
    factories.push(snapshot);
    size += added;
  }
  return { answer: { type: 'factories', requestId, factories }, left };
}
