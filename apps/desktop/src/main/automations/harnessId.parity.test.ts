import { describe, expect, it } from 'vitest';
import { HARNESS_ID_PATTERN as FACTORY_PATTERN } from '@consola/factory-spec';
import { HARNESS_ID_PATTERN } from '../../shared/harness';

/**
 * An agent file's `harness:` is checked by factory-spec, which may import
 * nothing from the app, so it keeps its own copy of the pattern Settings ›
 * Harnesses gives an id. This keeps the two one rule.
 */
describe('the harness id pattern', () => {
  it('is the same in factory-spec and the app', () => {
    expect(FACTORY_PATTERN.source).toBe(HARNESS_ID_PATTERN.source);
    expect(FACTORY_PATTERN.flags).toBe(HARNESS_ID_PATTERN.flags);
  });

  it.each([
    ['claude-work', true],
    ['claude_work-2', true],
    ['claude work', false],
    ['', false],
    ['claude/work', false],
  ])('both read %j alike', (id, valid) => {
    expect(FACTORY_PATTERN.test(id)).toBe(valid);
    expect(HARNESS_ID_PATTERN.test(id)).toBe(valid);
  });
});
