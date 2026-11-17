import type { Attention } from '../../shared/attention';

/**
 * Something that has entries worth the person's attention. Sessions are the
 * only one today; open automation runs join in slice 6 by registering another.
 */
export interface AttentionSource {
  kind: string;
  /** Every entry's current attention, by entry key. */
  read(): Map<string /* EntryKey */, Attention>;
  /** What this source says holds a session: sessionId to the entries holding it. */
  holds?(): Map<string /* sessionId */, string[] /* EntryKey[] */>;
  /** Hear that `read()` may now answer differently. Returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
}
