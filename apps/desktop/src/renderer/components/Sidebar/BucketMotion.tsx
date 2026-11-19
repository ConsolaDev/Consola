import { Component, type RefObject } from 'react';
import { EASE_OUT } from '../../hooks/useSettleOnChange';
import type { Bucket } from '../../sidebar/bucketize';
import { departures, travelDuration, type Placement } from '../../sidebar/departures';
import type { EntryKey } from '../../sidebar/entry';

const BUCKETS: Bucket[] = ['waiting', 'working', 'snoozed', 'settled'];

/** More rows than this leaving in one go (a batch settle) is a flock, not a gesture: they simply go. */
const MAX_TRAVELLERS = 3;

/** Rows closing the gap a row left, and a shelf making room for one: the rail's short settle. */
const MAKE_ROOM_MS = 200;

/** How long a landed row keeps easing its shadow away; matches the CSS transition. */
const LANDING_MS = 180;

/** The list's own arrival for a row (`@keyframes session-row-in`). */
const ROW_ARRIVAL = 'session-row-in';

interface Traveller {
  key: EntryKey;
  to: Bucket;
  /** Where the row was drawn before it left. */
  from: DOMRect;
  /** The row as it was, copied for a ghost when its destination is folded away. */
  row: HTMLElement;
}

interface Snapshot {
  travellers: Traveller[];
  /** Where every row and shelf was drawn (its top), and the section it sat in. */
  was: Map<string, { top: number; bucket: Bucket }>;
}

interface BucketMotionProps {
  /** Where each tree sits in this render. */
  placement: Placement;
  /** The sidebar: where the lists are, and where a ghost is drawn. */
  rootRef: RefObject<HTMLElement | null>;
}

const listOf = (root: Element, bucket: Bucket) =>
  root.querySelector<HTMLElement>(`.session-list[data-bucket="${bucket}"]`);

/** Working's or Settled's section in the dock; the list at the top has none. */
const shelfOf = (root: Element, bucket: Bucket) =>
  root.querySelector<HTMLElement>(`[data-shelf="${bucket}"]`);

const shelfKey = (bucket: Bucket) => `shelf:${bucket}`;

/** A list's own rows, one per tree; a conductor's children ride inside their tree's. */
function rowsOf(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return Array.from(list.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.entryKey !== undefined,
  );
}

const rowIn = (list: HTMLElement | null, key: EntryKey) =>
  rowsOf(list).find((row) => row.dataset.entryKey === key);

/** How much of an element its scrolling and clipping ancestors leave on screen, from 0 to 1. */
function visibleFraction(element: HTMLElement, root: HTMLElement): number {
  const box = element.getBoundingClientRect();
  if (box.height <= 0) return 0;
  let top = box.top;
  let bottom = box.bottom;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflowY !== 'visible') {
      const clip = parent.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    if (parent === root) break;
  }
  return Math.max(0, bottom - top) / box.height;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A row leaving the top of the list for Working or Settled travels there,
 * instead of vanishing from one place and appearing in another a sidebar away.
 *
 * It lifts off its slot, glides down to where it lands, and settles flush;
 * the rows it left close the gap behind it, and the shelf it joins makes room
 * and counts it as it arrives. A folded shelf has no slot to land in, so a
 * copy of the row slides down into the dock, under its top edge, the way a
 * drawer takes something put away.
 *
 * Nothing here decides where a row goes, or waits for anything: the list is
 * already in its final state when the motion starts, which only shows the
 * way it got there. Transform and opacity only; none at all under reduced
 * motion.
 *
 * A class because the motion needs the list as it was drawn *before* React
 * changes it, and `getSnapshotBeforeUpdate` is the one place that sees it.
 * It renders nothing and reads the DOM only on a render where a row left.
 */
export class BucketMotion extends Component<BucketMotionProps> {
  private mounted = false;
  private pending: Snapshot | null = null;
  /** Everything in flight, so an unmount can put it all back. */
  private readonly inFlight = new Set<() => void>();
  private readonly slides = new WeakMap<Element, Animation>();
  /** Lists opened to let a row fly in over their edge, by how many are flying. */
  private readonly opened = new Map<HTMLElement, number>();

  componentDidMount() {
    this.mounted = true;
  }

  componentWillUnmount() {
    this.mounted = false;
    this.pending = null;
    for (const stop of [...this.inFlight]) stop();
  }

  getSnapshotBeforeUpdate(previous: BucketMotionProps): Snapshot | null {
    const root = this.props.rootRef.current;
    if (!root || reducedMotion()) return null;
    const moved = departures(previous.placement, this.props.placement);
    if (moved.length === 0) return null;

    const was: Snapshot['was'] = new Map();
    for (const bucket of BUCKETS) {
      for (const row of rowsOf(listOf(root, bucket))) {
        was.set(row.dataset.entryKey!, { top: row.getBoundingClientRect().top, bucket });
      }
      const shelf = shelfOf(root, bucket);
      if (shelf) was.set(shelfKey(bucket), { top: shelf.getBoundingClientRect().top, bucket });
    }
    const travellers =
      moved.length > MAX_TRAVELLERS
        ? []
        : moved.flatMap(({ key, from, to }) => {
            const row = rowIn(listOf(root, from), key);
            // A row scrolled out of sight would fly in from under the filter bar.
            if (!row || visibleFraction(row, root) < 0.5) return [];
            return [{ key, to, from: row.getBoundingClientRect(), row }];
          });
    return { travellers, was };
  }

  componentDidUpdate(_previous: BucketMotionProps, _state: unknown, snapshot: Snapshot | null) {
    if (!snapshot) return;
    // Played once the task's renders are done, still before anything is
    // painted: a row starting work opens Working in a layout effect
    // (`useRevealWorking`), and the row should fly into the open shelf rather
    // than at a folded one that opens a moment later.
    if (this.pending) {
      merge(this.pending, snapshot);
      return;
    }
    this.pending = snapshot;
    queueMicrotask(() => this.flush());
  }

  render() {
    return null;
  }

  private flush() {
    const snapshot = this.pending;
    this.pending = null;
    const root = this.props.rootRef.current;
    if (!snapshot || !root || !this.mounted) return;

    // Where everything is now, read in one pass before anything moves: a shelf
    // sliding would carry its rows with it and corrupt every read after it.
    const shelves = BUCKETS.flatMap((bucket) => {
      const shelf = shelfOf(root, bucket);
      return shelf ? [{ bucket, shelf, before: snapshot.was.get(shelfKey(bucket)) }] : [];
    });
    const rows = BUCKETS.flatMap((bucket) =>
      rowsOf(listOf(root, bucket)).map((row) => ({
        bucket,
        row,
        before: snapshot.was.get(row.dataset.entryKey!),
      })),
    );
    for (const { shelf } of shelves) this.slides.get(shelf)?.cancel();
    for (const { row } of rows) this.slides.get(row)?.cancel();
    const arrivals = snapshot.travellers.map((traveller) => {
      const list = listOf(root, traveller.to);
      const row = rowIn(list, traveller.key);
      // The flight is its arrival, so the list's own fade-in (on the row, and
      // on a tree's children) does not play under it. Only that one: a
      // spinner cancelled here would never turn again.
      for (const animation of row?.getAnimations({ subtree: true }) ?? []) {
        if (animation instanceof CSSAnimation && animation.animationName === ROW_ARRIVAL)
          animation.cancel();
      }
      // A shelf that does not scroll is opened so the row is seen crossing
      // into it. One that scrolls stays clipped, and the row slides in at its edge.
      const landing =
        row && list && visibleFraction(row, root) >= 0.5
          ? {
              row,
              list,
              to: row.getBoundingClientRect(),
              open: list.scrollHeight <= list.clientHeight + 1,
            }
          : null;
      return { traveller, landing };
    });
    const shelfTop = new Map(
      shelves.map(({ bucket, shelf }) => [bucket, shelf.getBoundingClientRect().top]),
    );
    const rowTop = new Map(rows.map(({ row }) => [row, row.getBoundingClientRect().top]));

    // Everything that stayed where it was slides from where it was drawn, so
    // the gap a row left closes and the shelf a row joins opens, instead of
    // either happening in a frame. A shelf in the dock moves as one piece and
    // its rows only by what they moved within it: a row pushed past its own
    // list's edge would be clipped, and summon that list's scrollbar.
    const shelfShift = new Map<Bucket, number>();
    for (const { bucket, shelf, before } of shelves) {
      if (before) {
        shelfShift.set(bucket, this.slide(shelf, before.top - shelfTop.get(bucket)!));
        continue;
      }
      // A shelf that only now exists (Working, as its first session starts)
      // shows its header fading in above the row on its way there.
      const header = shelf.querySelector<HTMLElement>(':scope > .shelf-header');
      if (header)
        this.track(
          header.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: MAKE_ROOM_MS,
            easing: EASE_OUT,
          }),
        );
    }
    const travelling = new Set<string>(snapshot.travellers.map((traveller) => traveller.key));
    for (const { bucket, row, before } of rows) {
      if (travelling.has(row.dataset.entryKey!) || before?.bucket !== bucket) continue;
      this.slide(row, before.top - rowTop.get(row)! - (shelfShift.get(bucket) ?? 0));
    }

    const counted = new Set<Bucket>();
    for (const { traveller, landing } of arrivals) {
      const duration = landing
        ? this.fly(landing, traveller.from, shelfShift.get(traveller.to) ?? 0)
        : this.stowAway(root, traveller);
      if (duration === null || counted.has(traveller.to)) continue;
      counted.add(traveller.to);
      this.countOnArrival(shelfOf(root, traveller.to), duration);
    }
  }

  /** Slides an element by `delta` back to where it is now. Returns the delta it slid, 0 for none. */
  private slide(element: HTMLElement, delta: number): number {
    if (Math.abs(delta) < 1) return 0;
    const animation = element.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
      {
        duration: MAKE_ROOM_MS,
        easing: EASE_OUT,
      },
    );
    this.slides.set(element, animation);
    this.track(animation);
    return delta;
  }

  /**
   * The row itself, already in its new section, flown there from where it was.
   * `shelfShift` is how far its shelf is sliding as it makes room: the row
   * rides inside it, so it only travels the rest.
   */
  private fly(
    { row, list, to, open }: { row: HTMLElement; list: HTMLElement; to: DOMRect; open: boolean },
    from: DOMRect,
    shelfShift: number,
  ): number {
    const dx = from.left - to.left;
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const duration = travelDuration(dy);
    if (open) this.open(list);
    row.dataset.travelling = '';
    const flight = row.animate(
      [{ transform: `translate(${dx}px, ${dy - shelfShift}px)` }, { transform: 'none' }],
      { duration, easing: EASE_OUT },
    );
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      this.inFlight.delete(land);
      delete row.dataset.travelling;
      // Lands flush: the fill it carried is the colour under it, so only the
      // shadow is left to ease away.
      row.dataset.landed = '';
      window.setTimeout(() => delete row.dataset.landed, LANDING_MS);
      if (open) this.close(list);
    };
    this.inFlight.add(land);
    flight.finished.then(land, land);
    return duration;
  }

  /**
   * A copy of the row, sliding down under the dock's top edge: the shelf it
   * joined is folded, so there is no slot to show it landing in. It stays
   * whole all the way, because a copy fading over other rows reads as two
   * labels printed on top of each other.
   */
  private stowAway(root: HTMLElement, traveller: Traveller): number | null {
    const dock = root.querySelector<HTMLElement>('.sidebar-dock');
    if (!dock) return null;
    const sidebar = root.getBoundingClientRect();
    const floor = dock.getBoundingClientRect().top;
    const { from } = traveller;
    if (from.top >= floor) return null;

    // Everything above the dock, and nothing below it: the copy goes under
    // the edge rather than over the shelves.
    const clip = document.createElement('div');
    clip.className = 'sidebar-ghost-clip';
    clip.setAttribute('aria-hidden', 'true');
    clip.setAttribute('inert', '');
    clip.style.width = `${sidebar.width}px`;
    clip.style.height = `${floor - sidebar.top}px`;
    const ghost = document.createElement('div');
    ghost.className = 'sidebar-ghost';
    ghost.style.width = `${from.width}px`;
    ghost.style.height = `${from.height}px`;
    ghost.append(traveller.row.cloneNode(true));
    clip.append(ghost);
    root.append(clip);
    // Where a fixed box at 0,0 actually lands, whatever contains it.
    const origin = clip.getBoundingClientRect();
    clip.style.left = `${sidebar.left - origin.left}px`;
    clip.style.top = `${sidebar.top - origin.top}px`;

    const x = from.left - sidebar.left;
    const y = from.top - sidebar.top;
    // Until its top has passed the edge, plus the shadow under it.
    const dy = floor - from.top + 4;
    const duration = travelDuration(dy);
    ghost.style.transform = `translate(${x}px, ${y}px)`;
    const flight = ghost.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: `translate(${x}px, ${y + dy}px)` }],
      { duration, easing: EASE_OUT, fill: 'forwards' },
    );
    const remove = () => {
      this.inFlight.delete(remove);
      clip.remove();
    };
    this.inFlight.add(remove);
    flight.finished.then(remove, remove);
    return duration;
  }

  /** The shelf's count ticks over as the row arrives, not when it sets off. */
  private countOnArrival(shelf: HTMLElement | null, duration: number) {
    const count = shelf?.querySelector<HTMLElement>('.shelf-header-count');
    if (!count) return;
    for (const animation of count.getAnimations()) animation.cancel();
    this.track(
      count.animate(
        [
          { opacity: 0, transform: 'translateY(-4px)' },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: 220,
          delay: Math.round(duration * 0.55),
          easing: EASE_OUT,
          fill: 'backwards',
        },
      ),
    );
  }

  private open(list: HTMLElement) {
    this.opened.set(list, (this.opened.get(list) ?? 0) + 1);
    list.dataset.travelOpen = '';
  }

  private close(list: HTMLElement) {
    const left = (this.opened.get(list) ?? 1) - 1;
    if (left > 0) {
      this.opened.set(list, left);
      return;
    }
    this.opened.delete(list);
    delete list.dataset.travelOpen;
  }

  /** Keeps an animation cancellable on unmount until it ends. */
  private track(animation: Animation) {
    const stop = () => animation.cancel();
    this.inFlight.add(stop);
    const done = () => this.inFlight.delete(stop);
    animation.finished.then(done, done);
  }
}

/**
 * Folds a later snapshot from the same task into one not yet played. Where the
 * two disagree the earlier wins: it is what was on screen.
 */
function merge(into: Snapshot, next: Snapshot) {
  for (const [key, value] of next.was) if (!into.was.has(key)) into.was.set(key, value);
  const known = new Set(into.travellers.map((traveller) => traveller.key));
  for (const traveller of next.travellers)
    if (!known.has(traveller.key)) into.travellers.push(traveller);
}
