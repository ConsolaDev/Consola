import { describe, expect, it } from 'vitest';
import { commitMessage, flaggedPaths, RunCheckoutError, runOwnedDirName } from './runCheckout';

/* The pure half of a run's own checkout (slice 3-B): its folder's name, Consola's commit message, what is flagged. */

describe('runOwnedDirName', () => {
  it("is the repository's name and the run's first 8", () => {
    expect(runOwnedDirName('sprocket/catalog-portal', '3f2a91c0aa11')).toBe(
      'catalog-portal-run-3f2a91c0',
    );
    expect(runOwnedDirName('sprocket/api', 'abc')).toBe('api-run-abc');
  });
});

describe('commitMessage', () => {
  it('names the step, its attempt, the automation and the item or run', () => {
    expect(commitMessage('fix', 2, 'ui-bug-to-pr', 'SHOP-42')).toBe(
      'fix (attempt 2) of ui-bug-to-pr on SHOP-42',
    );
  });
});

describe('flaggedPaths', () => {
  it('keeps what changes how an agent, git or CI behaves, and drops the rest', () => {
    expect(
      flaggedPaths([
        'src/a.ts',
        '.claude/x',
        'pkg/CLAUDE.md',
        '.mcp.json',
        '.github/workflows/ci.yml',
        '.husky/pre-commit',
        '.gitattributes',
      ]),
    ).toEqual([
      '.claude/x',
      'pkg/CLAUDE.md',
      '.mcp.json',
      '.github/workflows/ci.yml',
      '.husky/pre-commit',
      '.gitattributes',
    ]);
  });

  it('flags them at any depth, and a name that only looks like one is not flagged', () => {
    expect(
      flaggedPaths([
        'CLAUDE.md',
        'pkg/.claude/agents/x.md',
        'pkg/.gitattributes',
        'docs/claude.md.txt',
        'src/github/x.ts',
        'a.mcp.json',
        '.claudex/y',
      ]),
    ).toEqual(['CLAUDE.md', 'pkg/.claude/agents/x.md', 'pkg/.gitattributes']);
  });
});

describe('RunCheckoutError', () => {
  it('says which stage, and why', () => {
    const error = new RunCheckoutError('fetch', 'could not read from remote');
    expect(error).toBeInstanceOf(Error);
    expect(error.stage).toBe('fetch');
    expect(error.message).toBe('could not read from remote');
    expect(error.name).toBe('RunCheckoutError');
  });
});
