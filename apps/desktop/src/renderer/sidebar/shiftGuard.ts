/**
 * How long a row the list just moved ignores presses. A click already on its
 * way when the row slid under the pointer lands inside this window.
 */
export const MOVED_ROW_PRESS_MS = 500;

/**
 * Moves this soon after the person's own press or key are theirs: the next row
 * sliding up after Settle, a row leaving for Working after Enter. The same
 * window as Cumulative Layout Shift's `hadRecentInput`.
 */
export const OWN_INPUT_MS = 500;

/** Where a row was laid out: its top, unmoved by scrolling, and its height. */
export interface RowBox {
  top: number;
  height: number;
}

export type Verdict = 'pass' | 'drop';

export type ShiftGuard = ReturnType<typeof createShiftGuard>;

/**
 * Drops presses on rows that something other than the person just moved, so a
 * session finishing, asking or arriving above the pointer cannot hand its
 * click to the row that slid in under it.
 *
 * The decisions only; the sidebar feeds it the DOM's events and layout
 * (`useShiftGuard`). Rows are known by entry key, because a row that changes
 * section is a different element in a different list.
 *
 * A dropped press stays dropped until its own pointer lifts or cancels, so a
 * key or another pointer meanwhile cannot hand that press's click to the row.
 */
export function createShiftGuard(now: () => number) {
  let boxes: ReadonlyMap<string, RowBox> | null = null;
  const movedAt = new Map<string, number>();
  let lastInputAt = Number.NEGATIVE_INFINITY;
  /** Pointers still down on a dropped press. */
  const heldDrops = new Set<number>();
  /** Whether the last press was dropped, for follow-ups that carry no pointer. */
  let pressDropped = false;
  /** The pointer whose dropped press just lifted: its click is still to come. */
  let releasedDrop: number | null = null;

  return {
    /** A pointer went down, on the row with this key or on none. */
    press(pointerId: number, row: string | null): Verdict {
      // A new press from the same pointer means its earlier release was missed.
      heldDrops.delete(pointerId);
      if (releasedDrop === pointerId) releasedDrop = null;
      const at = now();
      const moved = row === null ? undefined : movedAt.get(row);
      if (moved !== undefined && at - moved < MOVED_ROW_PRESS_MS) {
        heldDrops.add(pointerId);
        pressDropped = true;
        return 'drop';
      }
      pressDropped = false;
      lastInputAt = at;
      return 'pass';
    },

    /** A pointer lifted. A dropped press's release is swallowed only over a row. */
    release(pointerId: number, row: string | null): Verdict {
      const dropped = heldDrops.delete(pointerId);
      releasedDrop = dropped ? pointerId : null;
      pressDropped = dropped;
      if (dropped) return row === null ? 'pass' : 'drop';
      lastInputAt = now();
      return 'pass';
    },

    cancel(pointerId: number): void {
      heldDrops.delete(pointerId);
    },

    /** A key went down. Editing text cannot move rows, so it is not input that does. */
    key(editsText: boolean): void {
      pressDropped = false;
      if (!editsText) lastInputAt = now();
    },

    /**
     * A click, auxclick, double click or context menu: dropped when the press
     * it follows was. `pointerId` is absent for one with no pointer behind it.
     */
    followUp(pointerId: number | undefined, row: string | null): Verdict {
      const dropped =
        pointerId !== undefined && pointerId >= 0
          ? heldDrops.has(pointerId) || releasedDrop === pointerId
          : pressDropped;
      return dropped && row !== null ? 'drop' : 'pass';
    },

    /**
     * Where every row is laid out after a render. A row that moved by at least
     * half its height marks itself moved, unless the person's own input just
     * moved it; less than that still leaves the row the pointer aimed at under
     * it. A list filling from empty slid nothing under the pointer.
     */
    layout(next: ReadonlyMap<string, RowBox>): void {
      const at = now();
      const own = boxes === null || boxes.size === 0 || at - lastInputAt < OWN_INPUT_MS;
      for (const [row, box] of next) {
        const before = boxes?.get(row);
        if (before !== undefined && Math.abs(box.top - before.top) * 2 < box.height) continue;
        // The latest move decides: one the person caused clears an earlier mark.
        if (own) movedAt.delete(row);
        else movedAt.set(row, at);
      }
      for (const row of [...movedAt.keys()]) if (!next.has(row)) movedAt.delete(row);
      boxes = next;
    },
  };
}
