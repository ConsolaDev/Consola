import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOW_READ_CHECKED,
  budgetFlags,
  CREDENTIAL_PATHS,
  denyReadList,
  FILE_TOOL_RULES_NEEDED,
  fileToolDenyRules,
  PINNED_SOCKET_KEYS,
  sandboxSettings,
  sandboxSettingsProblem,
  UNIX_SOCKETS_PINNED,
  userDataFamily,
  writeAgentArgs,
} from './claudeWriteAgent';

const CHECKOUT = '/w/catalog-portal-run-3f2a91c0';

describe("a write agent's deny list (Call 21)", () => {
  it("holds the fixed list, Consola's data and every effective profile, and never the worktree root (review B2)", () => {
    const list = denyReadList({
      home: '/h',
      userData: '/h/Library/Application Support/Consola Dev',
      factoryRoot: '/h/.consola/workspaces',
      profiles: ['/h/.claude-work', '/h/.claude-work', '/h/.claude'],
    });
    expect(list).toEqual(
      [
        ...CREDENTIAL_PATHS.map((rest) => `/h/${rest}`),
        '/h/.consola/workspaces',
        '/h/Library/Application Support/Consola',
        '/h/Library/Application Support/Consola Dev',
        '/h/Library/Application Support/Consola Test',
        '/h/.claude-work',
        '/h/.claude',
      ].sort(),
    );
    expect(
      list.some(
        (p) =>
          p === '/h/.consola' ||
          p.startsWith('/h/.consola/worktrees') ||
          p.startsWith('/h/.consola/run-git'),
      ),
    ).toBe(false);
  });

  it('names each entry through its real path where it exists', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-deny-')));
    try {
      fs.mkdirSync(path.join(dir, 'real-profile'));
      fs.symlinkSync(path.join(dir, 'real-profile'), path.join(dir, 'linked-profile'));
      const list = denyReadList({
        home: dir,
        userData: path.join(dir, 'Consola'),
        factoryRoot: path.join(dir, 'factories'),
        profiles: [path.join(dir, 'linked-profile')],
      });
      expect(list).toContain(path.join(dir, 'real-profile'));
      expect(list).not.toContain(path.join(dir, 'linked-profile'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("userData's family is the plain folder and its two siblings, from any of the three", () => {
    const family = ['/A/Consola', '/A/Consola Dev', '/A/Consola Test'];
    for (const one of family) expect(userDataFamily(one)).toEqual(family);
  });
});

describe("a write agent's sandbox", () => {
  it('runs only sandboxed, reaches only its hosts, reads nothing denied and cannot write the pointer', () => {
    expect(sandboxSettings({ network: ['registry.npmjs.org'] }, ['/h/.ssh'], CHECKOUT)).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: {
        allowedDomains: ['registry.npmjs.org'],
        ...(UNIX_SOCKETS_PINNED ? PINNED_SOCKET_KEYS : {}),
      },
      filesystem: { denyRead: ['/h/.ssh'], denyWrite: [`${CHECKOUT}/.git`] },
    });
  });

  it('an empty network list is no network, and nothing local joins it (the ruling on canary row 39)', () => {
    const settings = sandboxSettings({ network: [] }, [], CHECKOUT);
    expect(settings.network.allowedDomains).toEqual([]);
    expect(JSON.stringify(settings)).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it('allows reading its plugin folder inside the denied factory root once canary row 35 passed', () => {
    const settings = sandboxSettings({ network: [] }, ['/h/.consola/workspaces'], CHECKOUT, '/p');
    expect(settings.filesystem.allowRead).toEqual(ALLOW_READ_CHECKED ? ['/p'] : undefined);
  });
});

describe("a write agent's file tools' deny rules", () => {
  it('always deny editing or writing the checkout’s .git pointer (Call 9); Read rules only where row 44 needed them (Call 22)', () => {
    const rules = fileToolDenyRules(['/h/.ssh', '/h/.claude.json'], CHECKOUT);
    expect(rules.slice(-2)).toEqual([
      'Edit(//w/catalog-portal-run-3f2a91c0/.git)',
      'Write(//w/catalog-portal-run-3f2a91c0/.git)',
    ]);
    expect(rules.filter((rule) => rule.startsWith('Read('))).toEqual(
      FILE_TOOL_RULES_NEEDED
        ? [
            'Read(//h/.ssh)',
            'Read(//h/.ssh/**)',
            'Read(//h/.claude.json)',
            'Read(//h/.claude.json/**)',
          ]
        : [],
    );
  });
});

describe("the person's own sandbox settings (Call 24, review S7)", () => {
  it.each([
    [
      [
        {
          path: '/h/.claude-work/settings.json',
          text: '{"sandbox":{"excludedCommands":["curl"]}}',
        },
      ],
      "/h/.claude-work/settings.json sets `sandbox`, which Claude may add to this agent's sandbox, and Consola can't check what it changes. Remove it there, or give write agents a harness of their own.",
    ],
    [
      [
        { path: '/h/.claude-work/settings.json', text: null },
        {
          path: '/Library/Application Support/ClaudeCode/managed-settings.json',
          text: '{"sandbox":{"enabled":false}}',
        },
      ],
      '/Library/Application Support/ClaudeCode/managed-settings.json sets `sandbox`',
    ],
    [
      [{ path: '/h/.claude-work/settings.json', text: '{ not json' }],
      '/h/.claude-work/settings.json is not JSON',
    ],
    [
      [{ path: '/h/.claude-work/settings.json', text: null, unreadable: 'EACCES' }],
      '/h/.claude-work/settings.json could not be read (EACCES)',
    ],
  ])('refuse `sandbox`: %j', (files, words) => {
    expect(sandboxSettingsProblem(files)).toContain(words);
  });

  it('settings without a sandbox key, or absent, refuse nothing', () => {
    expect(
      sandboxSettingsProblem([
        { path: '/h/.claude-work/settings.json', text: '{"model":"sonnet","env":{"sandbox":1}}' },
        { path: '/Library/Application Support/ClaudeCode/managed-settings.json', text: null },
      ]),
    ).toBeNull();
  });
});

describe("a write agent's flags", () => {
  const CONSOLA = [
    'mcp__consola__consola_work_item_context',
    'mcp__consola__consola_list_inbox',
    'mcp__consola__consola_set_outputs',
    'mcp__consola__consola_write_artifact',
    'mcp__consola__consola_read_artifact',
    'mcp__consola__consola_list_artifacts',
  ];

  it('an edit agent: no shell, its file tools, --restricted last', () => {
    expect(
      writeAgentArgs({ tools: 'edit', isolation: 'sandbox', deny: ['Edit(//x/.git)'] }),
    ).toEqual([
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob,Edit,Write',
      '--allowedTools',
      ...CONSOLA,
      'Edit',
      'Write',
      '--disallowedTools',
      'Edit(//x/.git)',
      '--restricted',
    ]);
  });

  it('a write agent on host keeps `git push` and `gh` out by convention; under sandbox it does not need to', () => {
    const host = writeAgentArgs({ tools: 'write', isolation: 'host', deny: ['Edit(//x/.git)'] });
    expect(host.slice(host.indexOf('--disallowedTools'))).toEqual([
      '--disallowedTools',
      'Edit(//x/.git)',
      'Bash(git push:*)',
      'Bash(gh:*)',
      '--restricted',
    ]);
    const sandboxed = writeAgentArgs({ tools: 'write', isolation: 'sandbox' });
    expect(sandboxed).not.toContain('--disallowedTools');
    expect(sandboxed.slice(sandboxed.indexOf('--tools'), sandboxed.indexOf('--tools') + 2)).toEqual(
      ['--tools', 'Read,Grep,Glob,Edit,Write,Bash'],
    );
    expect(sandboxed.at(-1)).toBe('--restricted');
  });

  it('a connector drops --strict-mcp-config; skills add the Skill tool and their allow rules', () => {
    const args = writeAgentArgs({
      tools: 'write',
      isolation: 'sandbox',
      strict: false,
      skills: true,
      allowed: ['mcp__claude_ai_Linear__*', 'Skill(consola-step:triage)'],
    });
    expect(args).not.toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write,Bash,Skill');
    expect(args.slice(-4)).toEqual([
      'Bash',
      'mcp__claude_ai_Linear__*',
      'Skill(consola-step:triage)',
      '--restricted',
    ]);
  });
});

describe('--max-budget-usd (Call 15)', () => {
  it('is what is left, rounded down to the cent and at least one, once canary row 40 passed', () => {
    expect(budgetFlags(4.97, true)).toEqual(['--max-budget-usd', '4.97']);
    expect(budgetFlags(4.979, true)).toEqual(['--max-budget-usd', '4.97']);
    expect(budgetFlags(0, true)).toEqual(['--max-budget-usd', '0.01']);
    expect(budgetFlags(undefined, true)).toEqual([]);
  });

  it('is never passed while the canary has not seen the CLI stop at it', () => {
    expect(budgetFlags(4.97, false)).toEqual([]);
  });
});
