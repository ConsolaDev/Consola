import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readCodexRateLimits } from './codexAppServer';
import { codexPlanApplies, mapCodexUsage, showsCodexLimitNotice } from './codexUsage';

const CHECKED_AT = Date.parse('2026-11-19T14:00:00Z');
const RESET_SECONDS = 1_795_715_672;

/** A ChatGPT reading whose `codex` snapshot is `snapshot`, in 0.169.0's shape. */
function reading(snapshot: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const full: Record<string, unknown> = {
    limitId: 'codex',
    limitName: null,
    primary: null,
    secondary: null,
    individualLimit: null,
    planType: 'plus',
    rateLimitReachedType: null,
    ...snapshot,
  };
  return {
    accountType: 'chatgpt',
    requiresOpenaiAuth: true,
    rateLimits: { rateLimits: full, rateLimitsByLimitId: { codex: full }, ...extra },
  };
}

const windowsOf = (raw: unknown) => {
  const limits = mapCodexUsage(raw, CHECKED_AT);
  if (!limits.available) throw new Error('expected limits');
  return limits.windows;
};

describe('mapCodexUsage', () => {
  it('takes each position’s kind from the length Codex reports', () => {
    expect(
      windowsOf(
        reading({
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: RESET_SECONDS },
          secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: RESET_SECONDS + 60 },
        }),
      ),
    ).toEqual([
      { id: 'primary', kind: 'session', usedPercent: 40, resetsAt: RESET_SECONDS * 1000 },
      { id: 'secondary', kind: 'weekly', usedPercent: 12, resetsAt: (RESET_SECONDS + 60) * 1000 },
    ]);
    // Prolite reports its weekly allowance as `primary`.
    expect(
      windowsOf(reading({ primary: { usedPercent: 0, windowDurationMins: 10_080 } }))[0].kind,
    ).toBe('weekly');
    expect(
      windowsOf(reading({ primary: { usedPercent: 0, windowDurationMins: 43_200 } }))[0].kind,
    ).toBe('monthly');
  });

  it('without a length, reads primary as five hours — a month on free and go — and secondary as a week', () => {
    const plain = windowsOf(
      reading({ primary: { usedPercent: 1 }, secondary: { usedPercent: 2 } }),
    );
    expect(plain.map((window) => window.kind)).toEqual(['session', 'weekly']);
    for (const planType of ['free', 'go']) {
      expect(windowsOf(reading({ planType, primary: { usedPercent: 1 } }))[0].kind).toBe('monthly');
    }
  });

  it('reads resets in epoch seconds, and leaves out one it cannot read', () => {
    const windows = windowsOf(
      reading({
        primary: { usedPercent: 100, resetsAt: null },
        secondary: { usedPercent: 100, resetsAt: '1795715672' },
      }),
    );
    expect(windows.map((window) => window.resetsAt)).toEqual([undefined, undefined]);
    expect(windowsOf(reading({ primary: { usedPercent: 100, resetsAt: 0 } }))[0].resetsAt).toBe(
      undefined,
    );
  });

  it('leaves out a position with no usage figure', () => {
    expect(windowsOf(reading({ primary: { resetsAt: RESET_SECONDS }, secondary: null }))).toEqual(
      [],
    );
  });

  it('prefers the codex limit’s snapshot to the account default', () => {
    const raw = reading({ primary: { usedPercent: 5 } });
    raw.rateLimits.rateLimits = { ...raw.rateLimits.rateLimits, primary: { usedPercent: 99 } };
    expect(windowsOf(raw)[0].usedPercent).toBe(5);
    const fallback = { ...raw, rateLimits: { rateLimits: raw.rateLimits.rateLimits } };
    expect(windowsOf(fallback)[0].usedPercent).toBe(99);
  });

  it('gives no windows for another limit’s snapshot', () => {
    const raw = {
      ...reading({}),
      rateLimits: {
        rateLimits: {
          limitId: 'gpt-5-codex-mini',
          primary: { usedPercent: 100, resetsAt: RESET_SECONDS },
        },
      },
    };
    expect(windowsOf(raw)).toEqual([]);
  });

  it('reads the individual credit limit as a month, only for a plan with no windows of its own', () => {
    const individualLimit = { remainingPercent: 0, resetsAt: RESET_SECONDS };
    expect(windowsOf(reading({ individualLimit }))).toEqual([
      { id: 'individual', kind: 'monthly', usedPercent: 100, resetsAt: RESET_SECONDS * 1000 },
    ]);
    expect(
      windowsOf(reading({ individualLimit, primary: { usedPercent: 20 } })).map((w) => w.id),
    ).toEqual(['primary']);
  });

  it('reads an API key, nobody signed in, or another provider as no limits', () => {
    for (const raw of [
      { accountType: 'apiKey', requiresOpenaiAuth: true },
      { accountType: null, requiresOpenaiAuth: true },
      { ...reading({ primary: { usedPercent: 100 } }), requiresOpenaiAuth: false },
    ]) {
      expect(mapCodexUsage(raw, CHECKED_AT)).toEqual({ available: false });
    }
  });

  it('throws on a reading it does not recognise', () => {
    expect(() => mapCodexUsage(null, CHECKED_AT)).toThrow(/object/);
    expect(() => mapCodexUsage({ requiresOpenaiAuth: true }, CHECKED_AT)).toThrow(/account/);
    expect(() => mapCodexUsage({ accountType: 'chatgpt' }, CHECKED_AT)).toThrow(/no result/);
    expect(() =>
      mapCodexUsage({ accountType: 'chatgpt', rateLimits: { limits: {} } }, CHECKED_AT),
    ).toThrow(/snapshot/);
  });
});

describe('codexPlanApplies', () => {
  it('applies only to a ChatGPT account on OpenAI’s provider', () => {
    expect(codexPlanApplies({ accountType: 'chatgpt', requiresOpenaiAuth: true })).toBe(true);
    expect(codexPlanApplies({ accountType: 'chatgpt', requiresOpenaiAuth: false })).toBe(false);
    expect(codexPlanApplies({ accountType: 'apiKey', requiresOpenaiAuth: true })).toBe(false);
    expect(() => codexPlanApplies({ accountType: 3, requiresOpenaiAuth: true })).toThrow();
  });
});

describe('showsCodexLimitNotice', () => {
  it.each([
    "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:37 PM.",
    "■ You've hit your usage limit for gpt-5.5-codex. Switch to another model now, or try again at Nov 11th, 2026 3:37 PM.",
    "■ You've hit your usage limit. Try again at 3:37 PM.",
    "You've hit your usage limit.",
    '■ You’ve hit your usage limit. To get more access now, send a request to your admin',
  ])('sees %j', (line) => {
    expect(showsCodexLimitNotice(`• Explored\n\n${line}\n\n› `)).toBe(true);
  });

  it.each([
    "• When you've hit your usage limit for a key, back off.",
    "You've hit your usage limits on this key before.",
    "You've hit your usage limit on the staging key, so I paused.",
    '• Approaching rate limits',
  ])('does not see %j', (line) => {
    expect(showsCodexLimitNotice(`• Explored\n\n${line}\n\n› `)).toBe(false);
  });
});

/**
 * `readCodexRateLimits` against a stand-in `codex app-server` that answers
 * each request from a script, so the order of questions and what leaves the
 * reader can be checked without an account.
 */
describe('readCodexRateLimits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-codex-usage-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function fakeAppServer(name: string, answers: Record<string, unknown>): string {
    const script = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(
      script,
      `
      const answers = ${JSON.stringify(answers)};
      const asked = [];
      require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line);
        asked.push(message.method);
        if (message.id === undefined) return;
        process.stdout.write(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }) + '\\n');
        const answer = answers[message.method] ?? { result: {} };
        if (answer.result && message.method === 'account/rateLimits/read') answer.result.asked = asked;
        process.stdout.write(JSON.stringify({ id: message.id, ...answer }) + '\\n');
      });
      setTimeout(() => {}, 5000);
      `,
      'utf8',
    );
    const shim = path.join(dir, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    fs.chmodSync(shim, 0o755);
    return shim;
  }

  const SNAPSHOT = { limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 10_080 } };

  it('asks for rate limits after the account, and passes on only the snapshots', async () => {
    const binary = fakeAppServer('chatgpt', {
      'account/read': {
        result: {
          account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' },
          userId: 'user-123',
          requiresOpenaiAuth: true,
        },
      },
      'account/rateLimits/read': {
        result: {
          rateLimits: SNAPSHOT,
          rateLimitsByLimitId: { codex: SNAPSHOT },
          accountId: 'acct-123',
          rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'credit-1' }] },
        },
      },
    });

    const answer = await readCodexRateLimits(binary, dir, process.env);

    expect(answer).toEqual({
      accountType: 'chatgpt',
      requiresOpenaiAuth: true,
      rateLimits: { rateLimits: SNAPSHOT, rateLimitsByLimitId: { codex: SNAPSHOT } },
    });
    expect(JSON.stringify(answer)).not.toMatch(/someone@|user-123|acct-123|credit-1/);
  });

  it('does not ask for rate limits an API key does not have', async () => {
    const binary = fakeAppServer('apikey', {
      'account/read': { result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } },
      'account/rateLimits/read': {
        error: { code: -32_600, message: 'chatgpt authentication required to read rate limits' },
      },
    });

    expect(await readCodexRateLimits(binary, dir, process.env)).toEqual({
      accountType: 'apiKey',
      requiresOpenaiAuth: true,
    });
  });

  it('rejects on a JSON-RPC error', async () => {
    const binary = fakeAppServer('error', {
      'account/read': { result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } },
      'account/rateLimits/read': {
        error: { code: -32_603, message: 'failed to fetch codex rate limits' },
      },
    });

    await expect(readCodexRateLimits(binary, dir, process.env)).rejects.toThrow(/could not report/);
  });

  it('rejects on an account answer that does not say who is signed in', async () => {
    const binary = fakeAppServer('unknown', { 'account/read': { result: { profile: {} } } });

    await expect(readCodexRateLimits(binary, dir, process.env)).rejects.toThrow(/account/);
  });

  it('gives up at its deadline', async () => {
    const script = path.join(dir, 'silent');
    fs.writeFileSync(
      script,
      `#!/bin/sh\nexec "${process.execPath}" -e "setTimeout(() => {}, 60000)"\n`,
    );
    fs.chmodSync(script, 0o755);

    await expect(readCodexRateLimits(script, dir, process.env, [], 300)).rejects.toThrow(
      /within the timeout/,
    );
  });
});
