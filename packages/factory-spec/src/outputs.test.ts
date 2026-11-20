import { describe, expect, it } from 'vitest';
import { checkOutputs, coerceOutput, describeOutputType, type OutputType } from './outputs';

const declared: Record<string, OutputType> = {
  verdict: { type: 'enum', values: ['approve', 'comment', 'request-changes'] },
  findings: { type: 'integer', minimum: 0 },
  ok: { type: 'boolean' },
  note: { type: 'string', maxLength: 5 },
};

describe('describeOutputType', () => {
  it.each<[OutputType, string]>([
    [
      { type: 'enum', values: ['approve', 'comment', 'request-changes'] },
      'one of: approve, comment, request-changes',
    ],
    [{ type: 'integer', minimum: 0, maximum: 10 }, 'an integer from 0 to 10'],
    [{ type: 'integer', minimum: 0 }, 'an integer of at least 0'],
    [{ type: 'integer', maximum: 3 }, 'an integer of at most 3'],
    [{ type: 'integer' }, 'an integer'],
    [{ type: 'number' }, 'a number'],
    [{ type: 'number', minimum: 0, maximum: 1 }, 'a number from 0 to 1'],
    [{ type: 'boolean' }, 'true or false'],
    [{ type: 'string', maxLength: 500 }, 'text of at most 500 characters'],
  ])('describes %j', (type, text) => {
    expect(describeOutputType(type)).toBe(text);
  });
});

describe('checkOutputs', () => {
  it('checks values, keeping the valid ones', () => {
    const result = checkOutputs(declared, {
      verdict: 'lgtm',
      findings: 2,
      ok: true,
      extra: 1,
      note: 'toolong',
    });
    expect(result.valid).toEqual({ findings: 2, ok: true });
    expect(result.problems).toEqual([
      "verdict must be one of approve, comment, request-changes (got 'lgtm')",
      'note must be text of at most 5 characters (got 7)',
      'extra is not an output of this step (it has: verdict, findings, ok, note)',
    ]);
  });

  it('accepts all valid values', () => {
    const result = checkOutputs(declared, {
      verdict: 'comment',
      findings: 0,
      ok: false,
      note: 'abcde',
    });
    expect(result.problems).toEqual([]);
    expect(result.valid).toEqual({ verdict: 'comment', findings: 0, ok: false, note: 'abcde' });
  });

  it.each<[string, unknown, RegExp]>([
    ['a non-integer', 2.5, /must be an integer/],
    ['below the minimum', -1, /at least 0/],
    ['a string for an integer', '2', /must be an integer/],
  ])('refuses %s', (_name, value, problem) => {
    const result = checkOutputs(declared, { findings: value });
    expect(result.valid).toEqual({});
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(problem);
  });

  it('refuses a boolean given as text and a number past its maximum', () => {
    const result = checkOutputs(
      { ok: { type: 'boolean' }, score: { type: 'number', maximum: 1 } },
      { ok: 'true', score: 1.5 },
    );
    expect(result.valid).toEqual({});
    expect(result.problems[0]).toMatch(/^ok must be true or false/);
    expect(result.problems[1]).toMatch(/at most 1/);
  });

  it.each<unknown>([null, undefined, 'x', 3, ['a']])('refuses a non-object %j', (raw) => {
    expect(checkOutputs(declared, raw)).toEqual({
      valid: {},
      problems: ['Expected an object of outputs, e.g. { "verdict": "comment" }.'],
    });
  });
});

describe('coerceOutput', () => {
  it.each<[OutputType, string, unknown]>([
    [{ type: 'integer' }, '07', 7],
    [{ type: 'integer' }, '-3', -3],
    [{ type: 'number' }, '1e3', 1000],
    [{ type: 'number' }, '0.5', 0.5],
    [{ type: 'boolean' }, 'true', true],
    [{ type: 'boolean' }, 'false', false],
    [{ type: 'enum', values: ['approve', 'comment'] }, 'comment', 'comment'],
    [{ type: 'string', maxLength: 5 }, 'abcde', 'abcde'],
  ])('accepts %j from %j', (type, text, value) => {
    expect(coerceOutput(type, text)).toEqual({ ok: true, value });
  });

  it.each<[OutputType, string]>([
    [{ type: 'integer' }, '1.0'],
    [{ type: 'integer' }, ''],
    [{ type: 'integer' }, ' 1'],
    [{ type: 'integer', minimum: 1 }, '0'],
    [{ type: 'number' }, 'NaN'],
    [{ type: 'number' }, 'Infinity'],
    [{ type: 'number' }, ''],
    [{ type: 'number', maximum: 1 }, '2'],
    [{ type: 'boolean' }, 'True'],
    [{ type: 'boolean' }, '1'],
    [{ type: 'enum', values: ['approve'] }, 'Approve'],
    [{ type: 'string', maxLength: 5 }, 'abcdef'],
  ])('refuses %j from %j', (type, text) => {
    const result = coerceOutput(type, text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain(describeOutputType(type));
  });
});
