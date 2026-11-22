// Imported first, so this module's own import order is what loads it.
import {
  AGENT_SECRETS_REASON,
  ENTRY_SECRETS_REASON,
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRETS_PER_PLACE,
  parseSecretNames,
  secretNameProblem,
  secretTemplateReason,
} from './secrets';
import { describe, expect, it } from 'vitest';

const PATTERN = 'Use uppercase letters, digits and underscores, e.g. PAGERDUTY_TOKEN.';
const IDENTITY =
  "Commands act as the workspace's bound GitHub account, whose token Consola puts in `GH_TOKEN` (decision 37). To act as another account, bind it to the workspace.";

describe('secretNameProblem', () => {
  it('takes a name env: would take', () => {
    expect(secretNameProblem('PAGERDUTY_TOKEN')).toBeNull();
    expect(secretNameProblem('A')).toBeNull();
    expect(secretNameProblem('X'.repeat(MAX_SECRET_NAME_LENGTH))).toBeNull();
  });

  it('holds a name to the pattern', () => {
    expect(secretNameProblem('pagerduty')).toBe(PATTERN);
    expect(secretNameProblem('PAGER-TOKEN')).toBe(PATTERN);
    expect(secretNameProblem('')).toBe(PATTERN);
    // A lowercase name fails the pattern first, as in env:.
    expect(secretNameProblem('npm_config_x')).toBe(PATTERN);
  });

  it('holds a name to 64 characters', () => {
    expect(secretNameProblem('X'.repeat(65))).toBe("A secret's name is at most 64 characters.");
  });

  it("keeps CONSOLA_ for Consola's own", () => {
    expect(secretNameProblem('CONSOLA_TOKEN')).toBe(
      "`CONSOLA_` is Consola's own namespace; pick another name.",
    );
  });

  it.each([
    'PATH',
    'HOME',
    'BASH_ENV',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'GIT_ASKPASS',
    'NPM_CONFIG_X',
    'GH_REPO',
  ])('refuses %s as env: does', (name) => {
    const problem = secretNameProblem(name);
    expect(problem).toMatch(
      new RegExp(`^\`${name}\` is refused: a secret's name follows \`env:\`'s rules, and `),
    );
    expect(problem).toContain('BASH_ENV');
    expect(problem).toContain('LD_*');
    expect(problem).toMatch(/, make a program run a value\.$/);
  });

  it('says the whole refused sentence once', () => {
    expect(secretNameProblem('PATH')).toBe(
      "`PATH` is refused: a secret's name follows `env:`'s rules, and BASH_ENV, ENV, PROMPT_COMMAND, PS4, SHELLOPTS, BASHOPTS, IFS, HOME, ZDOTDIR, SSH_ASKPASS, PAGER, EDITOR, VISUAL, BROWSER, LESSOPEN, LESSCLOSE, GCONV_PATH, _JAVA_OPTIONS, PATH, and every name matching LD_*, DYLD_*, PYTHON*, PERL*, RUBY*, NODE_*, JAVA_*, NPM_CONFIG_*, XDG_*, GIT_*, GH_*, make a program run a value.",
    );
  });

  it("keeps GH_TOKEN and GH_HOST the bound account's, though env: takes them", () => {
    expect(secretNameProblem('GH_TOKEN')).toBe(IDENTITY);
    expect(secretNameProblem('GH_HOST')).toBe(IDENTITY);
  });

  it("keeps CLAUDE_CONFIG_DIR the harness's", () => {
    expect(secretNameProblem('CLAUDE_CONFIG_DIR')).toBe(
      "`CLAUDE_CONFIG_DIR` is the harness's own; a secret can't set it.",
    );
  });
});

describe('parseSecretNames', () => {
  const run = (raw: unknown, envNames?: readonly string[]) => {
    const issues: Array<{ message: string; path: Array<string | number> }> = [];
    const names = parseSecretNames(
      raw,
      (message, path = []) => issues.push({ message, path }),
      envNames,
    );
    return { names, issues };
  };

  it('keeps the names in order', () => {
    expect(run(['A_TOKEN', 'B_TOKEN'])).toEqual({ names: ['A_TOKEN', 'B_TOKEN'], issues: [] });
  });

  it('reads an empty list as none', () => {
    expect(run([])).toEqual({ names: [], issues: [] });
  });

  it('wants a list', () => {
    expect(run('A_TOKEN')).toEqual({
      names: null,
      issues: [
        {
          message: 'Expected `secrets` to be a list of names, e.g. `secrets: [PAGERDUTY_TOKEN]`.',
          path: [],
        },
      ],
    });
  });

  it('takes at most 20', () => {
    const names = Array.from({ length: MAX_SECRETS_PER_PLACE + 1 }, (_, i) => `T_${i}`);
    expect(run(names)).toEqual({
      names: null,
      issues: [{ message: '`secrets:` names at most 20 secrets.', path: [] }],
    });
    expect(run(names.slice(0, MAX_SECRETS_PER_PLACE)).names).toHaveLength(20);
  });

  it('refuses a name twice, at its second place', () => {
    expect(run(['A_TOKEN', 'A_TOKEN'])).toEqual({
      names: null,
      issues: [{ message: '`A_TOKEN` is listed twice in `secrets:`.', path: [1] }],
    });
  });

  it("refuses a name that is also in the step's env:", () => {
    expect(run(['TOKEN'], ['TOKEN'])).toEqual({
      names: null,
      issues: [
        {
          message: '`TOKEN` is in both `env:` and `secrets:`; a value comes from one place.',
          path: [0],
        },
      ],
    });
  });

  it('refuses what is not a name, at its place', () => {
    expect(run([1])).toEqual({ names: null, issues: [{ message: PATTERN, path: [0] }] });
    expect(run(['OK_TOKEN', 'GH_TOKEN']).issues).toEqual([{ message: IDENTITY, path: [1] }]);
  });
});

describe('the reasons', () => {
  it('says how a secret reaches a command', () => {
    expect(secretTemplateReason('PAGER_TOKEN')).toBe(
      'A secret reaches a command only as its own variable: add `secrets: [PAGER_TOKEN]` and use `$PAGER_TOKEN`.',
    );
    expect(secretTemplateReason()).toBe(
      'A secret reaches a command only as its own variable: add `secrets: [NAME]` and use `$NAME`.',
    );
  });

  it("says where an agent's and an entry's secrets go", () => {
    expect(AGENT_SECRETS_REASON).toBe(
      'A secret given to an agent can reach its model, its transcript and its pane. Give it to the command or server that needs it.',
    );
    expect(ENTRY_SECRETS_REASON).toBe('`secrets:` goes on the step that needs it.');
  });
});
