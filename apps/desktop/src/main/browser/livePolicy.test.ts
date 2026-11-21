import { describe, expect, it } from 'vitest';
import { decideLive, HIDDEN_UNLOAD_MS, MAX_LIVE_PAGES, type LiveCandidate } from './livePolicy';

const NOW = 10_000_000;

function page(id: string, minutesAgo: number, extra: Partial<LiveCandidate> = {}): LiveCandidate {
  return {
    id,
    lastShownAt: NOW - minutesAgo * 60_000,
    visible: false,
    toolCallInFlight: false,
    ...extra,
  };
}

describe('decideLive', () => {
  it('keeps a page hidden for less than the unload time', () => {
    expect([...decideLive([page('a', 14)], NOW)]).toEqual(['a']);
  });

  it('unloads a hidden page once the unload time has passed, at the boundary included', () => {
    expect(HIDDEN_UNLOAD_MS).toBe(15 * 60_000);
    expect(decideLive([page('a', 15)], NOW).has('a')).toBe(false);
    expect(decideLive([page('a', 90)], NOW).has('a')).toBe(false);
  });

  it('never unloads the visible page, however stale its stamp', () => {
    expect(decideLive([page('a', 600, { visible: true })], NOW).has('a')).toBe(true);
  });

  it('never unloads a page with a tool call in flight', () => {
    expect(decideLive([page('a', 600, { toolCallInFlight: true })], NOW).has('a')).toBe(true);
  });

  it('caps the live pages, dropping the least recently shown first', () => {
    expect(MAX_LIVE_PAGES).toBe(8);
    const pages = Array.from({ length: 10 }, (_, i) => page(`p${i}`, i)); // p0 newest
    const kept = decideLive(pages, NOW);
    expect(kept.size).toBe(8);
    expect(kept.has('p8')).toBe(false);
    expect(kept.has('p9')).toBe(false);
    expect(kept.has('p0')).toBe(true);
  });

  it('does not count an unloaded page against the cap', () => {
    const pages = [page('old', 60), ...Array.from({ length: 8 }, (_, i) => page(`p${i}`, i))];
    const kept = decideLive(pages, NOW);
    expect(kept.size).toBe(8);
    expect(kept.has('old')).toBe(false);
  });

  it('keeps exempt pages over the cap and drops others instead', () => {
    const pages = [
      page('visible', 14, { visible: true }),
      page('busy', 13, { toolCallInFlight: true }),
      ...Array.from({ length: 8 }, (_, i) => page(`p${i}`, i)),
    ];
    const kept = decideLive(pages, NOW);
    expect(kept.has('visible')).toBe(true);
    expect(kept.has('busy')).toBe(true);
    expect(kept.size).toBe(8);
    // The two oldest of the rest went.
    expect(kept.has('p7')).toBe(false);
    expect(kept.has('p6')).toBe(false);
  });

  it('may exceed the cap when every page is exempt', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      page(`p${i}`, 600, { toolCallInFlight: true }),
    );
    expect(decideLive(pages, NOW).size).toBe(10);
  });

  it('breaks a tie by input order: the earlier page goes first', () => {
    const pages = Array.from({ length: 9 }, (_, i) => page(`p${i}`, 1));
    const kept = decideLive(pages, NOW);
    expect(kept.has('p0')).toBe(false);
    expect(kept.size).toBe(8);
  });

  it('answers an empty set for no pages', () => {
    expect(decideLive([], NOW).size).toBe(0);
  });
});
