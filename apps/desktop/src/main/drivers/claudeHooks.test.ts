import { describe, expect, it } from 'vitest';
import type { AttentionSignal } from '../attention/hookSignals';
import { ClaudeDriver } from './ClaudeDriver';
import { claudeHookSettings, parseClaudeHookEvent } from './claudeHooks';

const URL = 'http://127.0.0.1:5555/attention/' + 'a'.repeat(48);
const driver = new ClaudeDriver();

const notification = (notification_type: string, message = 'prose that must never be read') => ({
  hook_event_name: 'Notification',
  notification_type,
  message,
});

describe('parseClaudeHookEvent', () => {
  const table: Array<[string, unknown, AttentionSignal | null]> = [
    [
      'permission_prompt (reported ~6s late)',
      notification('permission_prompt'),
      { kind: 'needs-input', origin: 'menu', lagging: true },
    ],

    [
      'UserPromptSubmit means an answer was given',
      { hook_event_name: 'UserPromptSubmit' },
      { kind: 'resumed' },
    ],
    [
      'elicitation_dialog',
      notification('elicitation_dialog'),
      { kind: 'needs-input', origin: 'question' },
    ],
    [
      'agent_needs_input',
      notification('agent_needs_input'),
      { kind: 'needs-input', origin: 'subagent' },
    ],
    ['idle_prompt', notification('idle_prompt'), { kind: 'idle' }],
    ['agent_completed', notification('agent_completed'), { kind: 'subagent-finished' }],
    ['auth_success says nothing about attention', notification('auth_success'), null],
    ['an unknown type says nothing', notification('something_new'), null],
    ['a prototype key is not a type', notification('constructor'), null],
    [
      'PermissionRequest is a menu being shown, for that call',
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { kind: 'needs-input', origin: 'menu', tool: 'Bash:{"command":"ls"}' },
    ],
    [
      'a PermissionRequest naming an agent is a subagent’s',
      { hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: {}, agent_id: 'a1' },
      { kind: 'needs-input', origin: 'subagent', tool: 'Read:{}' },
    ],
    [
      'PostToolUse names the call that completed',
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { kind: 'resumed', tool: 'Bash:{"command":"ls"}' },
    ],
    [
      'PostToolUse with no tool_name ties to no prompt',
      { hook_event_name: 'PostToolUse' },
      { kind: 'resumed', tool: 'unknown-call' },
    ],
    [
      'PostToolUse from a subagent says so',
      {
        hook_event_name: 'PostToolUse',
        agent_id: 'ae6d',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      },
      { kind: 'resumed', tool: 'Bash:{"command":"ls"}', agent: true },
    ],
    ['an unrelated event', { hook_event_name: 'PreToolUse' }, null],
    ['not an object', 'Notification', null],
    ['null', null, null],
  ];
  it.each(table)('%s', (_name, body, expected) => {
    expect(parseClaudeHookEvent(body)).toEqual(expected);
  });

  it('branches on notification_type, never on the message', () => {
    // Prose that sounds like a permission prompt, under a type that is not one.
    expect(
      parseClaudeHookEvent(notification('idle_prompt', 'Claude needs your permission')),
    ).toEqual({ kind: 'idle' });
    expect(
      parseClaudeHookEvent({
        hook_event_name: 'Notification',
        message: 'Claude needs your permission',
      }),
    ).toBeNull();
  });

  it('counts only the background tasks still running that a Stop reports', () => {
    const task = { id: 't1', type: 'shell', status: 'running' };
    expect(
      parseClaudeHookEvent({ hook_event_name: 'Stop', background_tasks: [task, task] }),
    ).toEqual({
      kind: 'turn-ended',
      backgroundWork: 2,
      backgroundAgents: 0,
    });
    const done = [
      { id: 't2', status: 'completed' },
      { id: 't3', status: 'failed' },
      { id: 't4' },
      'junk',
      null,
    ];
    expect(
      parseClaudeHookEvent({ hook_event_name: 'Stop', background_tasks: [...done, task] }),
    ).toEqual({
      kind: 'turn-ended',
      backgroundWork: 1,
      backgroundAgents: 0,
    });
    expect(parseClaudeHookEvent({ hook_event_name: 'Stop', background_tasks: done })).toEqual({
      kind: 'turn-ended',
      backgroundWork: 0,
      backgroundAgents: 0,
    });
    expect(parseClaudeHookEvent({ hook_event_name: 'Stop', background_tasks: [] })).toEqual({
      kind: 'turn-ended',
      backgroundWork: 0,
      backgroundAgents: 0,
    });
  });

  it('says which running background tasks are the agent’s own subagents (observed live, 2.1.326)', () => {
    const agent = (id: string, status: string) => ({
      id,
      type: 'subagent',
      status,
      description: 'Trace over-commitment data flow',
      agent_type: 'feature-dev:code-explorer',
    });
    const shell = { id: 'b1', type: 'local_bash', status: 'running' };
    expect(
      parseClaudeHookEvent({
        hook_event_name: 'Stop',
        background_tasks: [agent('a1', 'running'), agent('a2', 'running'), shell],
      }),
    ).toEqual({ kind: 'turn-ended', backgroundWork: 3, backgroundAgents: 2 });
    expect(
      parseClaudeHookEvent({
        hook_event_name: 'Stop',
        background_tasks: [agent('a1', 'completed'), shell],
      }),
    ).toEqual({ kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 });
  });

  it('does not hold a turn on a registry it could not read', () => {
    expect(parseClaudeHookEvent({ hook_event_name: 'Stop' })).toEqual({
      kind: 'turn-ended',
      backgroundWork: 0,
      backgroundAgents: 0,
    });
  });
});

describe('hook registration', () => {
  it('registers an http handler on loopback for the three events', () => {
    const settings = JSON.parse(claudeHookSettings(URL));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
      'UserPromptSubmit',
    ]);
    for (const groups of Object.values<any>(settings.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks).toEqual([expect.objectContaining({ type: 'http', url: URL })]);
    }
    expect(settings.hooks.Notification[0].matcher).toBe(
      'permission_prompt|elicitation_dialog|agent_needs_input|agent_completed|idle_prompt',
    );
  });

  it('is purely additive: only a hooks block, nothing that disables or replaces the user’s settings', () => {
    const settings = JSON.parse(claudeHookSettings(URL));
    expect(Object.keys(settings)).toEqual(['hooks']);
    expect(JSON.stringify(settings)).not.toMatch(
      /disableAllHooks|allowManagedHooksOnly|permissions|env/,
    );
  });

  it('adds --settings beside the session’s own args and keeps every one of them', () => {
    const args = driver.buildSessionArgs(
      { extraArgs: ['--verbose', '--model', 'opus'] },
      { sessionId: 'abc', resume: false, mcpConfigPath: '/tmp/c.json', attentionUrl: URL },
    );
    expect(args).toEqual([
      '--session-id',
      'abc',
      '--mcp-config',
      '/tmp/c.json',
      '--settings',
      claudeHookSettings(URL),
      '--verbose',
      '--model',
      'opus',
    ]);
  });

  it('passes no --settings when the endpoint is not there', () => {
    const args = driver.buildSessionArgs({ extraArgs: [] }, { sessionId: 'abc', resume: true });
    expect(args).toEqual(['--resume', 'abc']);
  });

  it('keeps the read-only policy last, so --restricted still closes the tool list', () => {
    const args = driver.buildSessionArgs(
      { extraArgs: [] },
      {
        sessionId: 'abc',
        resume: false,
        toolPolicy: 'read-only',
        unattended: true,
        initialPrompt: 'hi',
        attentionUrl: URL,
      },
    );
    expect(args[0]).toBe('-p');
    expect(args).toContain('--settings');
    expect(args.indexOf('--settings')).toBeLessThan(args.indexOf('--tools'));
    expect(args.slice(-3)).toEqual(['--restricted', '--', 'hi']);
  });
});
