import { describe, expect, it } from 'vitest';
import { yamlTokens } from './yamlTokens';
import type { YamlToken } from './yamlTokens';

const kinds = (tokens: YamlToken[]) =>
  tokens.filter((token) => token.kind !== 'space').map((token) => [token.kind, token.text]);

const FILE = `name: review-prs # the reviews
on: { github: pull_request.opened }
mode: confirm
steps:
  - id: review
    agent: reviewer
    max_turns: 30
    prompt: |
      Review {{ item.number }}.
      key: not a key
  - id: comment
    if: "steps.review.verdict != 'approve'"
    run: gh pr comment "$PR"
    env: [PR, ISSUE]
    dry: true
`;

describe('yamlTokens', () => {
  const lines = yamlTokens(FILE);

  it('gives every line back, token by token', () => {
    expect(lines.map((tokens) => tokens.map((token) => token.text).join(''))).toEqual(
      FILE.split('\n'),
    );
  });

  it('shades keys, values and a comment', () => {
    expect(kinds(lines[0])).toEqual([
      ['key', 'name'],
      ['colon', ':'],
      ['plain', 'review-prs'],
      ['comment', '# the reviews'],
    ]);
  });

  it('shades inside an inline map and list', () => {
    expect(kinds(lines[1])).toEqual([
      ['key', 'on'],
      ['colon', ':'],
      ['punct', '{'],
      ['key', 'github'],
      ['colon', ':'],
      ['plain', 'pull_request.opened'],
      ['punct', '}'],
    ]);
    expect(kinds(lines[13]).slice(2)).toEqual([
      ['punct', '['],
      ['plain', 'PR'],
      ['punct', ','],
      ['plain', 'ISSUE'],
      ['punct', ']'],
    ]);
  });

  it('shades a list item’s dash, numbers, strings and literals', () => {
    expect(kinds(lines[4])).toEqual([
      ['dash', '-'],
      ['key', 'id'],
      ['colon', ':'],
      ['plain', 'review'],
    ]);
    expect(kinds(lines[6])).toEqual([
      ['key', 'max_turns'],
      ['colon', ':'],
      ['number', '30'],
    ]);
    expect(kinds(lines[11])[2]).toEqual(['string', `"steps.review.verdict != 'approve'"`]);
    expect(kinds(lines[14])[2]).toEqual(['literal', 'true']);
  });

  it('reads a block scalar’s body as text, however it looks', () => {
    expect(kinds(lines[7])).toEqual([
      ['key', 'prompt'],
      ['colon', ':'],
      ['literal', '|'],
    ]);
    expect(kinds(lines[8])).toEqual([['string', 'Review {{ item.number }}.']]);
    expect(kinds(lines[9])).toEqual([['string', 'key: not a key']]);
    expect(kinds(lines[10])[1]).toEqual(['key', 'id']);
  });
});
