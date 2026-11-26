import { describe, expect, it } from 'vitest';
import {
  commitMessage,
  FLAGGED_FILE_NAMES,
  FLAGGED_FOLDER_NAMES,
  flaggedPaths,
  RunCheckoutError,
  runOwnedDirName,
} from './runCheckout';

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
        'pkg/.claudex/y',
      ]),
    ).toEqual(['CLAUDE.md', 'pkg/.claude/agents/x.md', 'pkg/.gitattributes']);
  });

  // The commit review's finding (MEDIUM): macOS reads `claude.md` as `CLAUDE.md`, and every CLI Consola drives has files of its own.
  it("compares case aside, as the Mac's file system does", () => {
    expect(
      flaggedPaths([
        'claude.md',
        'pkg/Claude.MD',
        'pkg/.CLAUDE/x.md',
        'pkg/.GitHub/workflows/ci.yml',
        'pkg/.MCP.json',
      ]),
    ).toEqual([
      'claude.md',
      'pkg/Claude.MD',
      'pkg/.CLAUDE/x.md',
      'pkg/.GitHub/workflows/ci.yml',
      'pkg/.MCP.json',
    ]);
  });

  it.each([
    'pkg/CLAUDE.local.md',
    'pkg/AGENTS.md',
    'pkg/AGENTS.override.md',
    'pkg/GEMINI.md',
    'pkg/.gitmodules',
    'pkg/.lfsconfig',
    'pkg/.codex/config.toml',
    'pkg/.gemini/settings.json',
    'pkg/.agents/skills/x/SKILL.md',
    'pkg/.claude-plugin/plugin.json',
  ])('flags %s, a file or folder an agent CLI Consola drives, or git, reads', (file) => {
    expect(flaggedPaths([file])).toEqual([file]);
  });

  it('flags every dotfile and dot-folder at the root, so a new one is never missed silently', () => {
    expect(
      flaggedPaths([
        '.npmrc',
        '.envrc',
        '.vscode/settings.json',
        '.cursor/rules/x.mdc',
        'src/.eslintrc',
      ]),
    ).toEqual(['.npmrc', '.envrc', '.vscode/settings.json', '.cursor/rules/x.mdc']);
  });

  it('keeps its names in one list each, case-folded', () => {
    for (const name of [...FLAGGED_FILE_NAMES, ...FLAGGED_FOLDER_NAMES]) {
      expect(name).toBe(name.toLowerCase());
    }
    expect(FLAGGED_FOLDER_NAMES).toEqual(
      expect.arrayContaining(['.claude', '.codex', '.gemini', '.agents']),
    );
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
