import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE_REVIEW_TEAM_FILES } from './codeReviewTeam.generated';

const templateDir = join(__dirname, '..', '..', 'templates', 'code-review-team');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.startsWith('.') ? [] : [relative(templateDir, path).split(sep).join('/')];
  });
}

describe('CODE_REVIEW_TEAM_FILES', () => {
  it('holds templates/code-review-team/ as it is on disk (run `templates:embed` after a change)', () => {
    const onDisk = filesUnder(templateDir)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((path) => ({ path, content: readFileSync(join(templateDir, path), 'utf8') }));
    expect(CODE_REVIEW_TEAM_FILES).toEqual(onDisk);
  });

  it('pins the two agents to their models', () => {
    const contentOf = (path: string) =>
      CODE_REVIEW_TEAM_FILES.find((f) => f.path === path)?.content;
    expect(contentOf('agents/orchestrator/agent.md')).toContain('\nmodel: claude-sonnet-5-5\n');
    expect(contentOf('agents/review/agent.md')).toContain('\nmodel: claude-opus-5-5\n');
  });
});

describe('the team module outside Node', () => {
  // As sha256.test.ts checks for src/: the web app reads factories in the browser.
  const BUILTIN = /from ['"](?:node:|(?:crypto|fs|path|os|child_process|util|stream|buffer)['"])/;

  it('imports no Node builtin outside its tests', () => {
    const shipped = readdirSync(__dirname).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    expect(shipped.length).toBeGreaterThan(0);
    expect(
      shipped.filter((file) => BUILTIN.test(readFileSync(join(__dirname, file), 'utf8'))),
    ).toEqual([]);
  });
});
