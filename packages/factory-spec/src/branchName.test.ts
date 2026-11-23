import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BRANCH_PLACEHOLDERS,
  branchTemplateProblem,
  cleanBranchPart,
  refFormatProblem,
  renderBranch,
} from './branchName';

/*
 * A branch name from an item key someone else wrote (slice 3-B, Call 7):
 * the key is cleaned by an allow-list, made unique by a hash of the
 * original when the clean lost anything, and only ever the last part of a
 * name the file starts with a literal folder. Every name is checked against
 * the real `git check-ref-format --branch`.
 */

const gitTakes = (name: string) => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Spike §3, as printed.
const SPIKE: Array<[string, string]> = [
  ['SHOP-42', 'fix/SHOP-42'],
  ['../../etc/passwd', 'fix/etc-passwd-3754d6cb'],
  ['--force', 'fix/force-be262a10'],
  ['a..b', 'fix/a.b-f62b4241'],
  ['a@{1}', 'fix/a-1-24151029'],
  ['x.lock.lock', 'fix/x-a3371857'],
  ['‮evil', 'fix/evil-c34b5d3b'],
  ['ЅHOP-42', 'fix/HOP-42-94dbe6b4'],
  ['$(touch /tmp/x)', 'fix/touch-tmp-x-851205e5'],
  ['line\nbreak', 'fix/line-break-697affca'],
  ['refs/heads/main', 'fix/refs-heads-main-f921bd05'],
  ['日本語', 'fix/item-77710aed'],
  ['', 'fix/item-e3b0c442'],
  ['ＳＨＯＰ－４２', 'fix/SHOP-42-bcb17604'],
  ['a\u0000b', 'fix/a-b-59b271ae'],
];

const MORE = [
  'x'.repeat(300),
  'HEAD',
  'main',
  '-x',
  '@',
  '.hidden',
  'a/b',
  'a//b',
  'trailing/',
  'trailing.',
  'x.lock',
  'a b',
  'tab\tkey',
  'a~1',
  'a^1',
  'a:b',
  'a?b',
  'a*b',
  'a[b',
  'a\\b',
  '🔥fix',
  'é',
  'a​b',
  '---',
  '...',
  'SHOP_42',
  'shop.42',
  'k'.repeat(61),
];

// Review M2: CI's package job runs on ubuntu-latest, the spike on Apple Git 2.50; say which git agreed.
beforeAll(() => console.info(execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()));

describe('renderBranch and cleanBranchPart', () => {
  it.each(SPIKE)('renders %j as the spike did', (key, name) =>
    expect(renderBranch('fix/{{item.key}}', { itemKey: key, runId: '3f2a91c0aa' })).toBe(name),
  );

  it.each([...SPIKE.map(([k]) => k), ...MORE])(
    'git takes the branch for %j, and so does refFormatProblem',
    (key) => {
      const name = renderBranch('fix/{{item.key}}', { itemKey: key, runId: '3f2a91c0aa' });
      expect(gitTakes(name)).toBe(true);
      expect(refFormatProblem(name)).toBeNull();
    },
  );

  it('never gives two keys one branch, and keeps a clean key as it is', () => {
    const keys = [...SPIKE.map(([k]) => k), ...MORE];
    const names = keys.map((k) => renderBranch('fix/{{item.key}}', { itemKey: k, runId: 'r' }));
    expect(new Set(names).size).toBe(new Set(keys).size);
    expect(cleanBranchPart('SHOP-42')).toBe('SHOP-42');
  });

  it('collapses a run of dashes the clean makes, and keeps the hash', () => {
    expect(cleanBranchPart('a--b')).toMatch(/^a-b-[0-9a-f]{8}$/);
    expect(cleanBranchPart('a-@-b')).toMatch(/^a-b-[0-9a-f]{8}$/);
  });

  it('cuts a long key at 60 characters, then adds the hash', () => {
    const part = cleanBranchPart('x'.repeat(300));
    expect(part).toMatch(/^x{60}-[0-9a-f]{8}$/);
  });

  it('renders every placeholder, the run id by its first 8 characters', () => {
    expect(
      renderBranch('consola/{{item.key}}-{{run.id}}', { itemKey: 'SHOP-42', runId: '3f2a91c0aa' }),
    ).toBe('consola/SHOP-42-3f2a91c0');
    expect(renderBranch('ui/pr-{{item.number}}', { itemNumber: 42, runId: 'r' })).toBe('ui/pr-42');
    expect(renderBranch('consola/run-{{ run.id }}', { runId: '3f2a91c0aa' })).toBe(
      'consola/run-3f2a91c0',
    );
  });

  it('refuses to render a placeholder it has no value for', () => {
    expect(() => renderBranch('fix/{{item.key}}', { runId: 'r' })).toThrow('item.key');
    expect(() => renderBranch('ui/pr-{{item.number}}', { runId: 'r' })).toThrow('item.number');
  });

  it('names the placeholders a branch takes', () =>
    expect([...BRANCH_PLACEHOLDERS]).toEqual(['item.key', 'item.number', 'run.id']));
});

describe('refFormatProblem', () => {
  it.each([
    '-x',
    'a..b',
    'a b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a/',
    'a.',
    '.a',
    'a/.b',
    'a.lock',
    'a//b',
    'a@{b',
    'fix/ok',
    'consola/SHOP-42-3f2a91c0',
    'f/x.y-z_1',
    // Beyond the plan's list: an empty name, a lone slash, a component ending .lock, a control character.
    '',
    '/',
    'a.lock/b',
    'a\u0001b',
    'a\u007fb',
    'é/x',
  ])('agrees with git on %j', (name) =>
    expect(refFormatProblem(name) === null).toBe(gitTakes(name)),
  );

  it.each(['HEAD', '@'])('refuses %j whatever this git says of it', (name) =>
    expect(refFormatProblem(name)).not.toBeNull(),
  );
});

describe('branchTemplateProblem', () => {
  it.each([
    ['{{item.key}}', 'A branch starts with a literal folder'],
    ['fix-{{item.key}}', 'A branch starts with a literal folder'],
    ['/fix/{{item.key}}', 'A branch starts with a literal folder'],
    ['fix/{{item.title}}', 'A branch takes only'],
    ['fix/../{{item.key}}', 'makes a branch name git refuses'],
    // Beyond the plan's list: an unclosed placeholder, and a stray closing one.
    ['fix/{{item.key', 'A branch takes only'],
    ['fix/item.key}}', 'A branch takes only'],
  ])('refuses the template %j', (template, words) =>
    expect(branchTemplateProblem(template)).toContain(words),
  );

  it.each([
    'fix/{{item.key}}',
    'consola/{{item.key}}-{{run.id}}',
    'ui/pr-{{item.number}}',
    'consola/run-{{run.id}}',
  ])('takes the template %j', (template) => expect(branchTemplateProblem(template)).toBeNull());

  it('says the words fixed for each refusal', () => {
    expect(branchTemplateProblem('{{item.key}}')).toBe(
      "A branch starts with a literal folder, e.g. `fix/{{item.key}}`, so an item's key is only ever its last part.",
    );
    expect(branchTemplateProblem('fix/{{item.title}}')).toBe(
      'A branch takes only `{{item.key}}`, `{{item.number}}` and `{{run.id}}`.',
    );
    expect(branchTemplateProblem('fix/../{{item.key}}')).toBe(
      '`fix/../{{item.key}}` makes a branch name git refuses (`fix/../SHOP-42`).',
    );
  });
});
