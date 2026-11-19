import { describe, expect, it } from 'vitest';
import { mapClaudeUsage, showsClaudeLimitNotice } from './claudeUsage';

const CHECKED_AT = Date.parse('2026-11-19T14:00:00Z');

const window = (utilization: unknown, resets_at: unknown) => ({
  utilization,
  resets_at,
  limit_dollars: null,
  used_dollars: null,
  remaining_dollars: null,
  locked_reason: null,
});

/** The shape `get_usage` answers with (2.1.328), trimmed to what is read. */
function answer(rateLimits: Record<string, unknown>) {
  return {
    session: { total_cost_usd: 0 },
    subscription_type: 'team',
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
      ...rateLimits,
    },
    behaviors: null,
  };
}

describe('mapClaudeUsage', () => {
  it('reads the five-hour, weekly and model-scoped windows', () => {
    const limits = mapClaudeUsage(
      answer({
        five_hour: window(73, '2026-11-19T18:10:00.081364+00:00'),
        seven_day: window(82, '2026-11-21T07:00:00.081387+00:00'),
        model_scoped: [
          { display_name: 'Fable', utilization: 67, resets_at: '2026-11-21T07:00:00.081587+00:00' },
        ],
      }),
      CHECKED_AT,
    );

    expect(limits).toEqual({
      available: true,
      checkedAt: CHECKED_AT,
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          usedPercent: 73,
          resetsAt: Date.parse('2026-11-19T18:10:00.081Z'),
        },
        {
          id: 'seven_day',
          kind: 'weekly',
          usedPercent: 82,
          resetsAt: Date.parse('2026-11-21T07:00:00.081Z'),
        },
        {
          id: 'seven_day:fable',
          kind: 'weekly',
          usedPercent: 67,
          model: 'Fable',
          resetsAt: Date.parse('2026-11-21T07:00:00.081Z'),
        },
      ],
    });
  });

  it('leaves out a window that is null or carries no utilisation', () => {
    const limits = mapClaudeUsage(
      answer({
        five_hour: window(null, '2026-11-19T18:10:00Z'),
        seven_day: window('82', '2026-11-21T07:00:00Z'),
        model_scoped: [
          { display_name: 'Fable', resets_at: '2026-11-21T07:00:00Z' },
          { display_name: '', utilization: 100, resets_at: '2026-11-21T07:00:00Z' },
          null,
        ],
      }),
      CHECKED_AT,
    );

    expect(limits).toEqual({ available: true, checkedAt: CHECKED_AT, windows: [] });
  });

  it('keeps a window whose reset cannot be read, without a time', () => {
    const limits = mapClaudeUsage(
      answer({ five_hour: window(100, 'next Tuesday'), seven_day: window(100, null) }),
      CHECKED_AT,
    );

    expect(limits.available && limits.windows).toEqual([
      { id: 'five_hour', kind: 'session', usedPercent: 100 },
      { id: 'seven_day', kind: 'weekly', usedPercent: 100 },
    ]);
  });

  it('reads a login without plan limits as none', () => {
    expect(
      mapClaudeUsage(
        { session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null },
        CHECKED_AT,
      ),
    ).toEqual({ available: false });
  });

  it('throws on an answer that does not say whether it has limits', () => {
    expect(() => mapClaudeUsage('nope', CHECKED_AT)).toThrow(/object/);
    expect(() => mapClaudeUsage({ rate_limits: {} }, CHECKED_AT)).toThrow(/whether/);
    expect(() => mapClaudeUsage({ rate_limits_available: 'yes' }, CHECKED_AT)).toThrow(/whether/);
    expect(() =>
      mapClaudeUsage({ rate_limits_available: true, rate_limits: null }, CHECKED_AT),
    ).toThrow(/without them/);
  });
});

describe('showsClaudeLimitNotice', () => {
  it.each([
    "You've hit your 5-hour limit · resets 3pm (Europe/Madrid)",
    "You've hit your weekly limit · resets Nov 21, 8am (Europe/Madrid) · progress saved",
    "You've hit your Opus limit",
    "You've hit your limit · resets 3pm (Europe/Madrid)",
    "You've hit your usage limit",
    "You've hit your org's monthly spend limit · ask your admin to raise it",
    "You've hit your team's pooled group budget · resets Dec 1",
    "You've reached your Fable limit for this week. Switch models?",
    "You're out of usage credits · resets 3pm (Europe/Madrid)",
    'You’ve hit your 5-hour limit · resets 3pm',
    "  ⎿  You've hit your 5-hour limit · resets 3pm (Europe/Madrid)",
    "⏺ You've hit your weekly limit   ",
  ])('sees %j', (line) => {
    expect(showsClaudeLimitNotice(`⏺ Working on it.\n\n${line}\n\n> `)).toBe(true);
  });

  it.each([
    // The agent's prose: mid-sentence, or closed by a full stop.
    "If you've hit your rate limit, wait for the reset.",
    "You've hit your rate limit.",
    "You've hit your limit on the staging API, so I stopped.",
    '  - "You\'ve hit your 5-hour limit" means the window is used up.',
    // Claude's own warnings before a limit: the turn has not stopped.
    "You've used 91% of your 5-hour limit · resets 3pm (Europe/Madrid)",
    "You're close to your weekly limit · resets Nov 21",
    'Approaching 5-hour limit · resets 3pm',
    "You're now using usage credits · Your weekly limit resets Nov 21",
  ])('does not see %j', (line) => {
    expect(showsClaudeLimitNotice(`⏺ Working on it.\n\n${line}\n\n> `)).toBe(false);
  });
});
