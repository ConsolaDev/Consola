import {
  FACTORIES_PER_ANSWER_MAX,
  readCellMessage,
  SOCKET_FRAME_MAX_BYTES,
} from '@consola/runner-protocol';
import type { FactorySnapshot } from '@consola/runner-protocol';
import { describe, expect, it } from 'vitest';
import { factoriesAnswer } from './runnerFactories.js';

const snapshot = (factoryId: string, bytes = 10, version = 1): FactorySnapshot => ({
  factoryId,
  version,
  files: [{ path: 'factory.yml', content: `version: 1\n${'#'.repeat(bytes)}` }],
});

const encodedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('factoriesAnswer', () => {
  it('holds every factory that fits, in order, as a message the runner reads', () => {
    const { answer, left } = factoriesAnswer('req-1', [snapshot('a'), snapshot('b', 10, 3)]);
    expect(answer).toEqual({
      type: 'factories',
      requestId: 'req-1',
      factories: [snapshot('a'), snapshot('b', 10, 3)],
    });
    expect(left).toEqual([]);
    expect(readCellMessage(JSON.parse(JSON.stringify(answer)))).toEqual({
      ok: true,
      value: answer,
    });
  });

  it('answers none at all with an empty list', () => {
    expect(factoriesAnswer('req-1', []).answer.factories).toEqual([]);
  });

  it('takes whole factories while the JSON fits, and leaves out the rest, never one in part', () => {
    const max = 1000;
    const { answer, left } = factoriesAnswer(
      'req-1',
      [snapshot('a', 300), snapshot('big', 2000), snapshot('b', 300), snapshot('c', 300)],
      max,
    );
    expect(answer.factories.map((f) => f.factoryId)).toEqual(['a', 'b']);
    expect(left).toEqual([
      { factoryId: 'big', version: 1, reason: 'too-large' },
      { factoryId: 'c', version: 1, reason: 'too-large' },
    ]);
    expect(encodedSize(answer)).toBeLessThanOrEqual(max);
  });

  it('measures exactly: an answer of exactly the frame fits, one byte more does not', () => {
    const base = encodedSize(factoriesAnswer('req-1', [snapshot('a', 100)]).answer);
    expect(factoriesAnswer('req-1', [snapshot('a', 100)], base).left).toEqual([]);
    expect(factoriesAnswer('req-1', [snapshot('a', 100)], base - 1).left).toHaveLength(1);
    // Text that takes more bytes than characters is measured in bytes.
    const wide = { factoryId: 'a', version: 1, files: [{ path: 'factory.yml', content: 'é' }] };
    const size = encodedSize({ type: 'factories', requestId: 'r', factories: [wide] });
    expect(factoriesAnswer('r', [wide], size).left).toEqual([]);
    expect(factoriesAnswer('r', [wide], size - 1).left).toHaveLength(1);
  });

  it("stays under the socket's frame by default", () => {
    // Three files of 700 KB: about half a frame each factory.
    const big = (factoryId: string): FactorySnapshot => ({
      factoryId,
      version: 1,
      files: ['a', 'b', 'c'].map((name) => ({
        path: `skills/${name}/SKILL.md`,
        content: 'x'.repeat(Math.floor(SOCKET_FRAME_MAX_BYTES / 6)),
      })),
    });
    const { answer, left } = factoriesAnswer('req-1', [big('a'), big('b'), snapshot('c', 10)]);
    expect(answer.factories.map((f) => f.factoryId)).toEqual(['a', 'c']);
    expect(left).toEqual([{ factoryId: 'b', version: 1, reason: 'too-large' }]);
    expect(encodedSize(answer)).toBeLessThanOrEqual(SOCKET_FRAME_MAX_BYTES);
  });

  it("keeps to the protocol's count of factories, and its files' bounds", () => {
    const many = Array.from({ length: FACTORIES_PER_ANSWER_MAX + 2 }, (_, i) => snapshot(`f${i}`));
    const { answer, left } = factoriesAnswer('req-1', many);
    expect(answer.factories).toHaveLength(FACTORIES_PER_ANSWER_MAX);
    expect(left.map((each) => each.reason)).toEqual(['too-many', 'too-many']);

    const longPath = {
      factoryId: 'p',
      version: 1,
      files: [{ path: 'x'.repeat(300), content: '' }],
    };
    expect(factoriesAnswer('req-1', [longPath]).left).toEqual([
      { factoryId: 'p', version: 1, reason: 'outside-the-protocol' },
    ]);
  });
});
