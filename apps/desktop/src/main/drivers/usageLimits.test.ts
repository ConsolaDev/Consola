import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HarnessDriverId } from '../../shared/types';
import { limitResetAt } from '../../shared/usageLimits';
import type { HarnessLimits } from '../../shared/usageLimits';
import { mapClaudeUsage } from './claudeUsage';
import { mapCodexUsage } from './codexUsage';
import { allDrivers } from './index';

vi.mock('../LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: process.env.PATH }) }));

/**
 * The contract every driver that reports usage limits keeps: replayed through
 * its mapper and the shared rule, its CLI's real answers give the reset they
 * say, and an answer that has drifted gives no time or throws — never a
 * different time that only looks right.
 *
 * The answers live in `__fixtures__/usage-limits/<driver id>/`: the real one
 * captured below the limit, the same shape at the limit with and without a
 * reset time, a login with no plan, and `expected.json` naming the fake `now`
 * the at-limit answer is read at and where its reset time sits.
 */

/**
 * Each driver's pure mapper, by driver id. A test seam only: production asks
 * `usageLimits.read`, which starts the CLI.
 */
const MAPPERS: Partial<
  Record<HarnessDriverId, (answer: unknown, checkedAt: number) => HarnessLimits>
> = {
  claude: mapClaudeUsage,
  codex: mapCodexUsage,
};

const FIXTURES = path.join(__dirname, '__fixtures__', 'usage-limits');

const REQUIRED_FILES = [
  'answer-below-limit.json',
  'answer-at-limit.json',
  'answer-at-limit-no-time.json',
  'answer-no-plan.json',
  'expected.json',
  'screen-limit-notice.txt',
  'screen-no-notice.txt',
];

interface Expected {
  now: string;
  stoppedAt: string;
  /** The session's model selector, when the binding window is scoped to one. */
  model?: string;
  resetsAt: string;
  /** Where the binding window's reset time sits in the at-limit answer. */
  resetPath: string[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonPath = Array<string | number>;

function read(driverId: string, file: string): string {
  return fs.readFileSync(path.join(FIXTURES, driverId, file), 'utf8');
}

function readJson<T = Json>(driverId: string, file: string): T {
  return JSON.parse(read(driverId, file)) as T;
}

/** Every path in `value`, parents before children. */
function pathsIn(value: Json, prefix: JsonPath = []): JsonPath[] {
  const children: Array<[string | number, Json]> = Array.isArray(value)
    ? value.map((child, index) => [index, child])
    : value !== null && typeof value === 'object'
      ? Object.entries(value)
      : [];
  return children.flatMap(([key, child]) => [
    [...prefix, key],
    ...pathsIn(child, [...prefix, key]),
  ]);
}

function at(value: Json, route: JsonPath): Json {
  return route.reduce<Json>((node, key) => (node as Record<string, Json>)[key], value);
}

/** A copy of `answer` with the field at `route` renamed. */
function renamed(answer: Json, route: JsonPath): Json {
  const copy = structuredClone(answer);
  const parent = at(copy, route.slice(0, -1)) as Record<string, Json>;
  const key = route[route.length - 1] as string;
  parent[`${key}_renamed`] = parent[key];
  delete parent[key];
  return copy;
}

/** A copy of `answer` with the value at `route` replaced. */
function replaced(answer: Json, route: JsonPath, value: Json): Json {
  const copy = structuredClone(answer);
  const parent = at(copy, route.slice(0, -1)) as Record<string | number, Json>;
  parent[route[route.length - 1]] = value;
  return copy;
}

/** Ways a reset time can be misread: absent, unreadable, or in the wrong unit. */
function malformedTimes(value: Json): Json[] {
  const variants: Json[] = [null, 'malformed', '2026-13-45T99:00:00Z', {}, true];
  if (typeof value === 'number') variants.push(value * 1000, value / 1000, String(value));
  if (typeof value === 'string') variants.push(Date.parse(value), Date.parse(value) / 1000);
  return variants;
}

const usageDrivers = allDrivers().filter((driver) => driver.usageLimits);

describe('Usage limit contract', () => {
  it('is kept by at least one driver', () => {
    expect(usageDrivers.length).toBeGreaterThan(0);
  });

  describe.each(usageDrivers.map((driver) => [driver.id, driver] as const))(
    '%s',
    (driverId, driver) => {
      const mapper = MAPPERS[driverId];

      it('has a mapper to replay answers through, and every fixture', () => {
        expect(mapper, `add ${driverId}'s mapper to MAPPERS`).toBeTypeOf('function');
        for (const file of REQUIRED_FILES) {
          expect(fs.existsSync(path.join(FIXTURES, driverId, file)), `${driverId}/${file}`).toBe(
            true,
          );
        }
      });

      if (!mapper) return;
      const expected = readJson<Expected>(driverId, 'expected.json');
      const now = Date.parse(expected.now);
      const when = { now, stoppedAt: Date.parse(expected.stoppedAt), model: expected.model };
      const resetsAt = Date.parse(expected.resetsAt);

      /** The reset an answer gives a session that stopped at `stoppedAt`, or `'threw'`. */
      const outcome = (answer: Json): number | undefined | 'threw' => {
        let limits: HarnessLimits;
        try {
          limits = mapper(answer, now);
        } catch {
          return 'threw';
        }
        return limitResetAt(limits, when);
      };

      it('reads the real answer, below the limit, as limits with no reset to wait for', () => {
        const limits = mapper(readJson(driverId, 'answer-below-limit.json'), now);
        expect(limits.available).toBe(true);
        expect(limitResetAt(limits, when)).toBeUndefined();
      });

      it('gives the binding window’s reset at the limit', () => {
        expect(Number.isFinite(resetsAt)).toBe(true);
        expect(resetsAt).toBeGreaterThan(now);
        expect(outcome(readJson(driverId, 'answer-at-limit.json'))).toBe(resetsAt);
      });

      it('gives no time at the limit when the answer carries none', () => {
        expect(outcome(readJson(driverId, 'answer-at-limit-no-time.json'))).toBeUndefined();
      });

      it('reads a login with no plan as no limits', () => {
        expect(mapper(readJson(driverId, 'answer-no-plan.json'), now)).toEqual({
          available: false,
        });
      });

      it('gives no time, or throws, when the reset time is renamed or malformed', () => {
        const answer = readJson(driverId, 'answer-at-limit.json');
        const route = expected.resetPath;
        expect(at(answer, route), 'resetPath names the reset time').not.toBeUndefined();
        const drifted = [
          renamed(answer, route),
          ...malformedTimes(at(answer, route)).map((value) => replaced(answer, route, value)),
        ];
        for (const variant of drifted) {
          expect([undefined, 'threw']).toContain(outcome(variant));
        }
      });

      it('never guesses a different time, whichever field drifts', () => {
        // Every field renamed, every value replaced: the answer may lose its
        // time or be refused, but a time it gives is the one the CLI meant.
        const answer = readJson(driverId, 'answer-at-limit.json');
        for (const route of pathsIn(answer)) {
          const variants = [replaced(answer, route, 'malformed'), replaced(answer, route, null)];
          if (typeof route[route.length - 1] === 'string') variants.push(renamed(answer, route));
          for (const variant of variants) {
            expect([undefined, 'threw', resetsAt], route.join('.')).toContain(outcome(variant));
          }
        }
      });

      it('recognises its CLI’s limit notice on screen, and not prose about limits', () => {
        const shows = driver.usageLimits?.showsLimitNotice;
        if (!shows) return;
        expect(shows(read(driverId, 'screen-limit-notice.txt'))).toBe(true);
        expect(shows(read(driverId, 'screen-no-notice.txt'))).toBe(false);
      });
    },
  );
});
