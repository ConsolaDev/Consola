import { describe, expect, it } from 'vitest';
import {
  findResultText,
  MAX_SUGGESTIONS,
  stepZoom,
  suggestFromHistory,
  zoomPercent,
} from './browserTools';

const entry = (url: string, title: string, at: number) => ({ url, title, at });

describe('stepZoom', () => {
  it('steps by half a level and resets to zero', () => {
    expect(stepZoom(0, 'in')).toBe(0.5);
    expect(stepZoom(0.5, 'out')).toBe(0);
    expect(stepZoom(2, 'reset')).toBe(0);
  });

  it('stops at the ends', () => {
    expect(stepZoom(4, 'in')).toBe(4);
    expect(stepZoom(-4, 'out')).toBe(-4);
  });

  it('treats a level that is not a number as the default', () => {
    expect(stepZoom(Number.NaN, 'in')).toBe(0.5);
  });
});

describe('zoomPercent', () => {
  it('shows the factor Chromium applies for a level', () => {
    expect(zoomPercent(0)).toBe(100);
    expect(zoomPercent(1)).toBe(120);
    expect(zoomPercent(-1)).toBe(83);
  });
});

describe('findResultText', () => {
  it('says nothing before a search', () => {
    expect(findResultText('', null)).toBe('');
  });
  it('shows the position among the matches', () => {
    expect(findResultText('a', { active: 2, total: 7 })).toBe('2 of 7');
  });
  it('says so when nothing matched', () => {
    expect(findResultText('a', { active: 0, total: 0 })).toBe('No matches');
  });
  it('shows nothing while the first result is pending', () => {
    expect(findResultText('a', null)).toBe('');
  });
});

describe('suggestFromHistory', () => {
  const history = [
    entry('https://example.com/docs', 'Docs home', 3),
    entry('https://news.test/', 'Daily news', 2),
    entry('https://example.com/blog', 'Blog', 1),
  ];

  it('offers nothing for an empty query', () => {
    expect(suggestFromHistory(history, '  ')).toEqual([]);
  });

  it('matches url or title, ignoring case, keeping newest first', () => {
    expect(suggestFromHistory(history, 'EXAMPLE').map((e) => e.url)).toEqual([
      'https://example.com/docs',
      'https://example.com/blog',
    ]);
    expect(suggestFromHistory(history, 'daily').map((e) => e.url)).toEqual(['https://news.test/']);
  });

  it('sorts by recency even when the list is not', () => {
    const shuffled = [history[2], history[0]];
    expect(suggestFromHistory(shuffled, 'example').map((e) => e.at)).toEqual([3, 1]);
  });

  it('leaves out the entry the bar already shows', () => {
    expect(
      suggestFromHistory(history, 'example', { exclude: 'https://example.com/docs' }).map(
        (e) => e.url,
      ),
    ).toEqual(['https://example.com/blog']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`https://a.test/${i}`, '', i));
    expect(suggestFromHistory(many, 'a.test')).toHaveLength(MAX_SUGGESTIONS);
    expect(MAX_SUGGESTIONS).toBe(8);
  });
});
