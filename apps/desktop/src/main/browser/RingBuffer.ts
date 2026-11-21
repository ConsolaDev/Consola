/**
 * The newest `capacity` items pushed, oldest first, and a count of the ones
 * pushed out before anyone read them.
 *
 * How much a page logs is up to the page, so main keeps only a bounded tail
 * of it: an unbounded record of a page's events is what crashed T3 Code's
 * main process.
 */
export class RingBuffer<T> {
  private items: T[] = [];
  private dropped = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`A ring holds at least one item, not ${capacity}.`);
    }
  }

  public get size(): number {
    return this.items.length;
  }

  public push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  /** Everything held, and how many were pushed out unread; the ring is then empty. */
  public drain(): { items: T[]; dropped: number } {
    const drained = { items: this.items, dropped: this.dropped };
    this.items = [];
    this.dropped = 0;
    return drained;
  }
}
