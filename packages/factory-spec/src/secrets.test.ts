// Imported first, so this module's own import order is what loads it.
import {
  AGENT_SECRETS_REASON,
  ENTRY_SECRETS_REASON,
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRETS_PER_PLACE,
  parseSecretNames,
  secretNameProblem,
  secretNamesOf,
  secretTemplateReason,
  secretUsesOf,
} from './secrets';
import { describe, expect, it } from 'vitest';
import { parseAutomationEntry } from './entry';
import { isStepsEntry, type Automation } from './schema';
import type { McpServerDefinition } from './servers';
import type { Step } from './steps';

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

  it("refuses gh's fallbacks too, which it reads when GH_TOKEN is unset (review M2)", () => {
    expect(secretNameProblem('GITHUB_TOKEN')).toBe(IDENTITY);
    expect(secretNameProblem('GITHUB_ENTERPRISE_TOKEN')).toBe(IDENTITY);
    // GH_ENTERPRISE_TOKEN was already refused, by env:'s GH_* prefix.
    expect(secretNameProblem('GH_ENTERPRISE_TOKEN')).toMatch(/^`GH_ENTERPRISE_TOKEN` is refused/);
    // Only those: a name that merely starts alike is a name.
    expect(secretNameProblem('GITHUB_APP_ID')).toBeNull();
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

describe('the names an entry uses', () => {
  const entry = (yaml: string): Automation => {
    const parsed = parseAutomationEntry(yaml);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return parsed.automation;
  };
  const WATCH = entry(
    [
      '- name: watch',
      '  on: { poll: { every: 30m, run: tracker list, key: .id, secrets: [TRACKER_TOKEN] } }',
      '  scope: api',
      '  mode: auto',
      '  steps:',
      '    - id: look',
      '      prompt: Look at it.',
      '    - id: page',
      '      run: page "$PAGER_TOKEN"',
      '      secrets: [PAGER_TOKEN]',
      '    - id: post',
      '      run: post "$TRACKER_TOKEN"',
      '      secrets: [TRACKER_TOKEN]',
      '      dry_run: run',
    ].join('\n'),
  );

  it('lists every place, steps in file order, then the check', () => {
    expect(secretUsesOf(WATCH)).toEqual([
      { name: 'PAGER_TOKEN', automation: 'watch', step: 'page' },
      { name: 'TRACKER_TOKEN', automation: 'watch', step: 'post' },
      { name: 'TRACKER_TOKEN', automation: 'watch', check: true },
    ]);
  });

  it('names each once, sorted', () => {
    expect(secretNamesOf(WATCH)).toEqual(['PAGER_TOKEN', 'TRACKER_TOKEN']);
  });

  it("leaves the check's out of what a run reads, and keeps only dry_run: run commands' in a dry run", () => {
    const checkOnly = entry(
      [
        '- name: check-only',
        '  on: { poll: { every: 30m, run: tracker list, key: .id, secrets: [CHECK_ONLY_TOKEN] } }',
        '  scope: api',
        '  mode: auto',
        '  steps:',
        '    - id: page',
        '      run: page "$PAGER_TOKEN"',
        '      secrets: [PAGER_TOKEN]',
      ].join('\n'),
    );
    expect(secretNamesOf(checkOnly)).toEqual(['CHECK_ONLY_TOKEN', 'PAGER_TOKEN']);
    expect(secretNamesOf(checkOnly, { runOnly: true })).toEqual(['PAGER_TOKEN']);
    expect(secretNamesOf(WATCH, { runOnly: true })).toEqual(['PAGER_TOKEN', 'TRACKER_TOKEN']);
    expect(secretNamesOf(WATCH, { runOnly: true, dryRun: true })).toEqual(['TRACKER_TOKEN']);
    expect(secretNamesOf(checkOnly, { runOnly: true, dryRun: true })).toEqual([]);
  });

  describe("a call's server", () => {
    const CALLS = entry(
      [
        '- name: brief',
        '  on: { cron: "0 9 * * 1-5" }',
        '  scope: api',
        '  steps:',
        '    - id: page',
        '      run: page "$PAGER_TOKEN"',
        '      secrets: [PAGER_TOKEN]',
        '    - id: post',
        '      uses: slack#chat_post_message',
        '    - id: clean',
        '      uses: consola#cleanup_stale_sessions',
      ].join('\n'),
    );
    const SERVERS: Record<string, McpServerDefinition> = {
      slack: {
        name: 'slack',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        secrets: ['SLACK_BOT_TOKEN'],
      },
    };
    const postRuns = (): Automation => {
      if (!isStepsEntry(CALLS)) throw new Error('steps');
      return {
        ...CALLS,
        steps: CALLS.steps.map((step) =>
          step.kind === 'uses' && step.id === 'post' ? { ...step, dryRun: 'run' } : step,
        ),
      } as Automation;
    };

    it("lists a call's server's names after the step's place, naming the server", () => {
      expect(secretUsesOf(CALLS, SERVERS)).toEqual([
        { name: 'PAGER_TOKEN', automation: 'brief', step: 'page' },
        {
          name: 'SLACK_BOT_TOKEN',
          automation: 'brief',
          step: 'post',
          server: { name: 'slack', transport: 'stdio' },
        },
      ]);
      // Without the factory's servers, 5a-1's callers see what they saw.
      expect(secretUsesOf(CALLS)).toEqual([
        { name: 'PAGER_TOKEN', automation: 'brief', step: 'page' },
      ]);
    });

    it("reads a call's server's names in a run, and in a dry run only a dry_run: run call's", () => {
      expect(secretNamesOf(CALLS, { runOnly: true, servers: SERVERS })).toEqual([
        'PAGER_TOKEN',
        'SLACK_BOT_TOKEN',
      ]);
      expect(secretNamesOf(CALLS, { servers: SERVERS })).toEqual([
        'PAGER_TOKEN',
        'SLACK_BOT_TOKEN',
      ]);
      expect(secretNamesOf(CALLS, { runOnly: true, dryRun: true, servers: SERVERS })).toEqual([]);
      expect(secretNamesOf(postRuns(), { runOnly: true, dryRun: true, servers: SERVERS })).toEqual([
        'SLACK_BOT_TOKEN',
      ]);
      expect(secretNamesOf(CALLS, { runOnly: true })).toEqual(['PAGER_TOKEN']);
    });

    it('names nothing for consola#, nor for a server the factory does not define', () => {
      expect(secretUsesOf(CALLS, {}).map((use) => use.name)).toEqual(['PAGER_TOKEN']);
      expect(secretNamesOf(CALLS, { servers: {} })).toEqual(['PAGER_TOKEN']);
      // A name Object.prototype has is no server of the factory's.
      const constructorCall = {
        ...CALLS,
        steps: [{ ...(CALLS as { steps: Step[] }).steps[1], server: 'constructor' }],
      } as Automation;
      expect(secretUsesOf(constructorCall, {})).toEqual([]);
    });
  });

  it('sees a command and a call inside a repeat: loop (the merge with slice 3)', () => {
    const LOOP = entry(
      [
        '- name: loop-page',
        '  on: manual',
        '  scope: api',
        '  steps:',
        '    - id: polish',
        '      repeat: { max: 3, until: steps.check.clean }',
        '      steps:',
        '        - id: check',
        '          run: page "$PAGER_TOKEN"',
        '          secrets: [PAGER_TOKEN]',
        '          dry_run: run',
        '          outputs: { clean: { type: boolean } }',
        '        - id: post',
        '          uses: slack#chat_post_message',
        '          with: { channel: "#ops" }',
      ].join('\n'),
    );
    const slack: McpServerDefinition = {
      name: 'slack',
      transport: 'stdio',
      command: '/usr/local/bin/slack-mcp',
      args: [],
      env: {},
      secrets: ['SLACK_BOT_TOKEN'],
    };
    expect(secretUsesOf(LOOP)).toEqual([
      { name: 'PAGER_TOKEN', automation: 'loop-page', step: 'check' },
    ]);
    expect(secretNamesOf(LOOP)).toEqual(['PAGER_TOKEN']);
    expect(secretNamesOf(LOOP, { runOnly: true })).toEqual(['PAGER_TOKEN']);
    expect(secretNamesOf(LOOP, { runOnly: true, dryRun: true })).toEqual(['PAGER_TOKEN']);
    expect(secretUsesOf(LOOP, { slack }).map(({ name, step }) => [name, step])).toEqual([
      ['PAGER_TOKEN', 'check'],
      ['SLACK_BOT_TOKEN', 'post'],
    ]);
    expect(secretNamesOf(LOOP, { servers: { slack } })).toEqual(['PAGER_TOKEN', 'SLACK_BOT_TOKEN']);
  });

  it('is empty for an entry that names none', () => {
    const prompt = entry(
      '- name: p\n  on: { cron: "0 9 * * 1-5" }\n  scope: api\n  run: { prompt: "x" }',
    );
    expect(secretUsesOf(prompt)).toEqual([]);
    expect(secretNamesOf(prompt)).toEqual([]);
  });
});
