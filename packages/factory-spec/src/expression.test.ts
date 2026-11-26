import { describe, expect, it } from 'vitest';
import {
  MAX_IF_LENGTH,
  checkExpression,
  evaluateExpression,
  expressionPaths,
  parseExpression,
} from './expression';
import type { Expr, ExprType, ExprValue, ExpressionScope, PathExpr } from './expression';

function parse(source: string): Expr {
  const result = parseExpression(source);
  if (!result.ok) throw new Error(`parse failed: ${result.problem}`);
  return result.expr;
}

/** A compact rendering of the tree, so a table can assert its shape. */
function shape(expr: Expr): unknown {
  switch (expr.kind) {
    case 'output':
      return `steps.${expr.step}.${expr.output}`;
    case 'item':
      return `item.${expr.field}`;
    case 'literal':
      return expr.value;
    case 'not':
      return ['!', shape(expr.operand)];
    default:
      return [expr.kind === 'compare' ? expr.op : expr.kind, shape(expr.left), shape(expr.right)];
  }
}

describe('MAX_IF_LENGTH', () => {
  it('is 500', () => expect(MAX_IF_LENGTH).toBe(500));
});

describe('parseExpression', () => {
  it.each<[string, string, unknown]>([
    [
      'a comparison with a string',
      `steps.review.verdict != 'approve'`,
      ['!=', 'steps.review.verdict', 'approve'],
    ],
    [
      'and, not and parentheses',
      `steps.x.n >= 2 && !(item.type == "pr")`,
      ['and', ['>=', 'steps.x.n', 2], ['!', ['==', 'item.type', 'pr']]],
    ],
    [
      'and binds tighter than or',
      `steps.x.ok || steps.y.ok && steps.z.ok`,
      ['or', 'steps.x.ok', ['and', 'steps.y.ok', 'steps.z.ok']],
    ],
    ['a negative decimal', `-3.5 < steps.x.n`, ['<', -3.5, 'steps.x.n']],
    ['an escaped quote', String.raw`item.title == 'it\'s'`, ['==', 'item.title', "it's"]],
    [
      'an escaped backslash',
      String.raw`item.title == "a\\b"`,
      ['==', 'item.title', String.raw`a\b`],
    ],
    ['a boolean literal', `steps.x.ok == true`, ['==', 'steps.x.ok', true]],
    ['a hyphenated step id', `steps.fix-it.done`, 'steps.fix-it.done'],
  ])('parses %s', (_name, source, expected) => {
    expect(shape(parse(source))).toEqual(expected);
  });

  it('slices the source into each node text', () => {
    const expr = parse(`steps.x.n >= 2 && item.type == 'pr'`);
    expect(expr.text).toBe(`steps.x.n >= 2 && item.type == 'pr'`);
    if (expr.kind !== 'and') throw new Error('expected and');
    expect(expr.left.text).toBe('steps.x.n >= 2');
    expect(expr.right.text).toBe(`item.type == 'pr'`);
  });

  it.each<[string, string, RegExp]>([
    ['a chain', 'a == b == c', /compare two values at a time/],
    ['a chain of paths', 'steps.a.x == steps.b.x == steps.c.x', /compare two values at a time/],
    ['a short path', 'steps.x', /steps\.<step>\.<output>/],
    ['a long path', 'steps.x.y.z', /steps\.<step>\.<output>/],
    ['an unterminated string', `'open`, /unterminated/],
    ['an unknown escape', String.raw`'\n'`, /only \\' \\" and \\\\/],
    ['a stray paren', ')', /unexpected `\)`/],
    ['an empty source', '', /empty/],
    ['a blank source', '   ', /empty/],
    ['a bare word', 'x', /not a path or a literal/],
    ['a missing close paren', '(steps.x.ok', /\)/],
    ['trailing text', 'steps.x.ok steps.y.ok', /unexpected/],
    ['a dangling operator', 'steps.x.ok &&', /unexpected end/],
  ])('refuses %s with a reason', (_name, source, problem) => {
    const result = parseExpression(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(problem);
  });

  it('refuses previous: an if: reads this run only', () => {
    expect(parseExpression(`previous.review.verdict == 'x'`)).toEqual({
      ok: false,
      problem:
        '`previous` is what the last run wrote, and an `if:` reads this run only (`previous` outputs in `if:` arrive with waiting runs).',
    });
  });
});

const scope: ExpressionScope = {
  output(step, output): ExprType | { problem: string } {
    if (step === 'later') return { problem: '`later` runs after this step' };
    if (step === 'nope') return { problem: 'there is no step `nope`' };
    if (step === 'review') {
      if (output === 'verdict') {
        return {
          kind: 'string',
          enum: { values: ['approve', 'comment', 'request-changes'], owner: 'verdict of review' },
        };
      }
      if (output === 'handover') return { problem: 'artifacts are prose; branch on an output' };
      return { problem: `review has no output \`${output}\` (it has: verdict)` };
    }
    if (step === 'fresh' && output === 'needed') return { kind: 'boolean' };
    if (step === 'x' && output === 'n') return { kind: 'number' };
    if (step === 'x' && output === 's') return { kind: 'string' };
    return { problem: `unexpected ${step}.${output}` };
  },
  item: () => ({ kind: 'unknown' }),
};

describe('checkExpression', () => {
  it.each<[string, string, string[] | RegExp[]]>([
    [
      'an out-of-enum literal',
      `steps.review.verdict == 'aprove'`,
      ['`aprove` is not a verdict of review (approve, comment, request-changes)'],
    ],
    ['an in-enum literal', `steps.review.verdict != 'approve'`, []],
    ['a boolean output alone', 'steps.fresh.needed', []],
    ['a number alone', 'steps.x.n', [/`steps\.x\.n` is a number; `if:` needs true or false/]],
    ['a number against a string', `steps.x.n == 'a'`, [/compares a number with a string/]],
    ['ordering strings', 'steps.x.s < 3', [/`<` compares numbers/]],
    ['not of a number', '!steps.x.n', [/`!` takes true or false/]],
    ['and of a number', 'steps.x.n && steps.fresh.needed', [/`&&` takes true or false/]],
    [
      'an item field against a path',
      'item.author == steps.x.s',
      [/an item field compares only with a literal/],
    ],
    ['an item field against a literal', `item.author == 'alice'`, []],
    ['an item field ordered with a number', 'item.number > 3', []],
    ['two numbers', 'steps.x.n >= 2 && !(item.type == "pr")', []],
    ['booleans compared', 'steps.fresh.needed == true', []],
    ['a bare item field', 'item.draft', [/`item\.draft`/]],
    ['a later step', 'steps.later.ok', ['`steps.later.ok`: `later` runs after this step']],
    ['an unknown step', 'steps.nope.ok', ['`steps.nope.ok`: there is no step `nope`']],
    [
      'an artifact',
      'steps.review.handover == 1',
      ['`steps.review.handover`: artifacts are prose; branch on an output'],
    ],
    [
      'a misspelled output',
      `steps.review.verdct == 'approve'`,
      ['`steps.review.verdct`: review has no output `verdct` (it has: verdict)'],
    ],
    [
      'every issue, not just the first',
      `steps.nope.a == 1 || steps.later.b == 2`,
      ['`steps.nope.a`: there is no step `nope`', '`steps.later.b`: `later` runs after this step'],
    ],
  ])('checks %s', (_name, source, expected) => {
    const issues = checkExpression(parse(source), scope);
    expect(issues).toHaveLength(expected.length);
    expected.forEach((want, index) => {
      if (typeof want === 'string') expect(issues[index]).toBe(want);
      else expect(issues[index]).toMatch(want);
    });
  });
});

describe('evaluateExpression', () => {
  const values: Record<string, ExprValue> = {
    'steps.review.verdict': 'approve',
    'steps.x.n': 2,
    'steps.x.ok': true,
    'steps.y.ok': false,
    'item.type': 'pr',
    'item.number': 10,
  };
  const lookup = (path: PathExpr): ExprValue | undefined =>
    values[path.kind === 'output' ? `steps.${path.step}.${path.output}` : `item.${path.field}`];

  it.each<[string, boolean]>([
    [`steps.review.verdict == 'approve'`, true],
    [`steps.review.verdict != 'approve'`, false],
    [`steps.review.verdict != 'comment'`, true],
    ['steps.x.n < 10', true],
    ['2 < 10', true],
    ['item.number > steps.x.n', true],
    ['steps.x.n >= 2', true],
    ['steps.x.n <= 1', false],
    ['steps.x.ok && !steps.y.ok', true],
    ['steps.y.ok || steps.x.ok && steps.y.ok', false],
    [`item.type == "pr" && steps.x.n == 2`, true],
    ['!(steps.x.ok == steps.y.ok)', true],
    ['true', true],
    ['false || false', false],
  ])('%s is %s', (source, expected) => {
    expect(evaluateExpression(parse(source), lookup)).toEqual({ ok: true, value: expected });
  });

  it('reports the first absent path in evaluation order', () => {
    const result = evaluateExpression(parse('steps.a.x == 1 && steps.b.y == 2'), lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toMatchObject({ kind: 'output', step: 'a', output: 'x' });
    }
  });

  it('does not read the right side when the left decides it', () => {
    expect(evaluateExpression(parse('false && steps.q.ok'), lookup)).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluateExpression(parse('steps.x.ok || steps.q.ok'), lookup)).toEqual({
      ok: true,
      value: true,
    });
  });

  it('reads the right side when the left does not decide it', () => {
    const result = evaluateExpression(parse('true && steps.q.ok'), lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toMatchObject({ kind: 'output', step: 'q', output: 'ok' });
    }
  });
});

describe('expressionPaths', () => {
  it('lists the paths it reads, in order', () => {
    const paths = expressionPaths(parse(`steps.a.x == 1 || item.type == 'pr'`));
    expect(paths.map((path) => path.text)).toEqual(['steps.a.x', 'item.type']);
    expect(paths.map((path) => path.kind)).toEqual(['output', 'item']);
  });

  it('lists a repeated path each time', () => {
    expect(expressionPaths(parse('steps.a.x && !steps.a.x'))).toHaveLength(2);
  });
});
