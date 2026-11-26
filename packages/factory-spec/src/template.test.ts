import { describe, expect, it } from 'vitest';
import {
  hasTemplateBraces,
  parseTemplate,
  renderTemplate,
  secretPathProblem,
  templatePaths,
} from './template';
import type { TemplatePart, TemplatePath } from './template';

function parts(text: string): TemplatePart[] {
  const result = parseTemplate(text);
  if (!result.ok) throw new Error(result.problem);
  return result.parts;
}

describe('parseTemplate', () => {
  it('says a secret is no template path, naming it', () => {
    expect(parseTemplate('{{secrets.PAGER_TOKEN}}')).toEqual({
      ok: false,
      problem: secretPathProblem('PAGER_TOKEN'),
    });
    expect(secretPathProblem('PAGER_TOKEN')).toBe(
      'a secret reaches a command only as its own variable: add `secrets: [PAGER_TOKEN]` and use `$PAGER_TOKEN`',
    );
    expect(parseTemplate('x {{ secrets }} y')).toEqual({
      ok: false,
      problem: secretPathProblem('NAME'),
    });
    expect(parseTemplate('{{item.title}} {{steps.a.b}}').ok).toBe(true);
  });

  it('parses paths and text', () => {
    expect(parts('PR {{ item.url }} by {{steps.review.verdict}}')).toEqual([
      { kind: 'text', text: 'PR ' },
      { kind: 'path', path: { root: 'item', field: 'url', text: 'item.url' } },
      { kind: 'text', text: ' by ' },
      {
        kind: 'path',
        path: {
          root: 'steps',
          step: 'review',
          name: 'verdict',
          file: false,
          text: 'steps.review.verdict',
        },
      },
    ]);
  });

  it('reads .file on an artifact', () => {
    expect(parts('{{steps.review.handover.file}}')).toEqual([
      {
        kind: 'path',
        path: {
          root: 'steps',
          step: 'review',
          name: 'handover',
          file: true,
          text: 'steps.review.handover.file',
        },
      },
    ]);
  });

  it('reads a step named output', () => {
    const [part] = parts('{{steps.fetch.output}}');
    expect(part).toMatchObject({ path: { name: 'output', file: false } });
  });

  it('allows hyphens in a step id', () => {
    expect(templatePaths('{{steps.run-tests.passed}}')).toHaveLength(1);
  });

  it('reads what the last run wrote, and its file', () => {
    expect(parts('{{previous.review.handover}}')).toEqual([
      {
        kind: 'path',
        path: {
          root: 'previous',
          step: 'review',
          name: 'handover',
          file: false,
          text: 'previous.review.handover',
        },
      },
    ]);
    expect(parts('{{previous.review.handover.file}}')).toEqual([
      {
        kind: 'path',
        path: {
          root: 'previous',
          step: 'review',
          name: 'handover',
          file: true,
          text: 'previous.review.handover.file',
        },
      },
    ]);
  });

  it('returns plain text unchanged, and nothing for an empty string', () => {
    expect(parts('no braces { here }')).toEqual([{ kind: 'text', text: 'no braces { here }' }]);
    expect(parts('')).toEqual([]);
  });

  it.each<[string, string | RegExp]>([
    ['{{title}}', '`{{title}}` is not a path; item fields are `{{item.title}}`'],
    ['{{ title }}', '`{{title}}` is not a path; item fields are `{{item.title}}`'],
    ['{{}}', /is not a path/],
    ['{{foo.bar}}', /is not a path/],
    ['{{item}}', /is not a path/],
    ['{{steps.review}}', /`steps.<step>.<output or artifact>`/],
    ['{{steps.a.b.c}}', /`steps.<step>.<output or artifact>`/],
    [
      '{{previous.review}}',
      '`{{previous.review}}` is not a path; use `previous.<step>.<artifact>`, optionally followed by `.file`',
    ],
    [
      '{{previous.review.handover.text}}',
      /`previous.<step>.<artifact>`, optionally followed by `.file`/,
    ],
    ['{{previous}}', /`previous.<step>.<artifact>`/],
    ['{{item.title.file}}', /`.file` names an artifact's file/],
    ['{{item.url', /unclosed/],
    ['ok {{item.url}} then {{steps.a.b', /unclosed/],
  ])('refuses %j', (text, problem) => {
    const result = parseTemplate(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (typeof problem === 'string') expect(result.problem).toBe(problem);
    else expect(result.problem).toMatch(problem);
  });
});

describe('templatePaths', () => {
  it('lists the paths in order, and none when it does not parse', () => {
    expect(templatePaths('{{item.key}} {{steps.a.b.file}}').map((p) => p.text)).toEqual([
      'item.key',
      'steps.a.b.file',
    ]);
    expect(templatePaths('{{item.key} {{title}}')).toEqual([]);
  });
});

describe('renderTemplate', () => {
  const values: Record<string, string> = {
    'item.url': 'https://x/1',
    'steps.review.verdict': 'approve',
  };
  const lookup = (path: TemplatePath) => values[path.text];

  it('renders text and values', () => {
    expect(renderTemplate(parts('PR {{item.url}}: {{ steps.review.verdict }}.'), lookup)).toEqual({
      ok: true,
      text: 'PR https://x/1: approve.',
    });
  });

  it('does not re-scan a value for braces', () => {
    const out = renderTemplate(parts('{{item.url}}'), () => '{{steps.a.b}}');
    expect(out).toEqual({ ok: true, text: '{{steps.a.b}}' });
  });

  it('returns the first absent value as missing', () => {
    const result = renderTemplate(parts('{{item.url}} {{steps.a.b}} {{steps.c.d}}'), lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing.text).toBe('steps.a.b');
  });

  it('treats an empty string as present', () => {
    expect(renderTemplate(parts('[{{item.url}}]'), () => '')).toEqual({ ok: true, text: '[]' });
  });
});

describe('hasTemplateBraces', () => {
  it.each<[string, boolean]>([
    ['{ {x} }', false],
    ['a{{b', true],
    ['{{item.url}}', true],
    ['{x}', false],
    ['', false],
  ])('%j is %s', (text, expected) => {
    expect(hasTemplateBraces(text)).toBe(expected);
  });
});
