import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';
import {
  AGENT_PERMISSIONS_REASON,
  ENTRY_PERMISSIONS_REASON,
  GITHUB_PERMISSIONS,
  LOOP_PERMISSIONS_REASON,
  parsePermissions,
  USES_PERMISSIONS_REASON,
} from './permissions';
import { isStepsEntry } from './schema';
import type { CommandStep } from './steps';

/** What `parsePermissions` returns for `raw`, and every issue it reported. */
function parse(raw: unknown) {
  const issues: Array<{ message: string; path: Array<string | number> }> = [];
  const value = parsePermissions(raw, (message, path = []) => issues.push({ message, path }));
  return { value, issues };
}

describe('parsePermissions', () => {
  it('reads each permission a step may ask for, read or write, in one order', () => {
    expect(GITHUB_PERMISSIONS).toEqual([
      'contents',
      'pull_requests',
      'issues',
      'checks',
      'statuses',
      'metadata',
    ]);
    expect(parse({ pull_requests: 'write' })).toEqual({
      value: { pull_requests: 'write' },
      issues: [],
    });
    // Kept in GITHUB_PERMISSIONS' order whatever order the file writes them in.
    const written = parse({
      metadata: 'read',
      statuses: 'write',
      checks: 'read',
      issues: 'write',
      pull_requests: 'read',
      contents: 'write',
    });
    expect(written.issues).toEqual([]);
    expect(Object.keys(written.value ?? {})).toEqual([...GITHUB_PERMISSIONS]);
  });

  it('refuses a name it does not take, with the names it does', () => {
    expect(parse({ deployments: 'write' })).toEqual({
      value: null,
      issues: [
        {
          message:
            '`deployments` is not a permission a step can ask for; a step asks for contents, pull_requests, issues, checks, statuses and metadata.',
          path: ['deployments'],
        },
      ],
    });
    // GitHub Actions' spelling, pointed at the API's.
    expect(parse({ 'pull-requests': 'write' }).issues).toEqual([
      { message: "Write `pull_requests`, as GitHub's API names it.", path: ['pull-requests'] },
    ]);
    // A name every object inherits is no permission either.
    expect(parse(JSON.parse('{"__proto__": "write"}')).value).toBeNull();
    expect(parse({ constructor: 'read' }).value).toBeNull();
  });

  it('takes read or write, and metadata only read', () => {
    for (const access of ['admin', 'none', true, 1, null, ['write']]) {
      expect(parse({ issues: access })).toEqual({
        value: null,
        issues: [{ message: 'Expected `read` or `write` for `issues`.', path: ['issues'] }],
      });
    }
    expect(parse({ metadata: 'write' }).issues).toEqual([
      { message: '`metadata` is read-only on GitHub: write `metadata: read`.', path: ['metadata'] },
    ]);
    expect(parse({ metadata: 'read' }).value).toEqual({ metadata: 'read' });
  });

  it('reports every entry that is wrong, and keeps none', () => {
    const { value, issues } = parse({ contents: 'read', issues: 'admin', deployments: 'write' });
    expect(value).toBeNull();
    expect(issues.map((issue) => issue.path)).toEqual([['issues'], ['deployments']]);
  });

  it('is a mapping with at least one permission', () => {
    const shape =
      'Expected `permissions` to map GitHub permissions to `read` or `write`, e.g. `permissions: { pull_requests: write }`.';
    for (const raw of ['write', ['pull_requests'], null, 3]) {
      expect(parse(raw)).toEqual({ value: null, issues: [{ message: shape, path: [] }] });
    }
    expect(parse({})).toEqual({
      value: null,
      issues: [
        {
          message:
            'Name at least one permission, e.g. `permissions: { pull_requests: write }`; a command that needs no GitHub token leaves `permissions:` out.',
          path: [],
        },
      ],
    });
  });
});

/** One entry on a pull request event, its steps the given YAML list items. */
const steps = (...items: string[]) =>
  parseFactorySpec(
    `version: 1\nautomations:\n  - name: a\n    on: { github: { events: [pull_request.opened] } }\n    steps:\n${items
      .map((item) => `      ${item.replace(/\n/g, '\n      ')}`)
      .join('\n')}\n`,
  );

const only = (result: ReturnType<typeof steps>) => {
  expect(result.automations).toEqual([]);
  expect(result.issues).toHaveLength(1);
  return result.issues[0];
};

describe('permissions: on a step', () => {
  it('is carried on a run: step that writes it, and absent from one that does not', () => {
    const result = steps(
      '- id: post\n  run: gh pr comment "$PR" --body hi\n  env: { PR: "{{item.url}}" }\n  permissions: { pull_requests: write, contents: read }',
      '- id: quiet\n  run: echo hi',
    );
    expect(result.issues).toEqual([]);
    const [automation] = result.automations;
    if (!automation || !isStepsEntry(automation)) throw new Error('no steps entry');
    const [post, quiet] = automation.steps as CommandStep[];
    expect(post.permissions).toEqual({ contents: 'read', pull_requests: 'write' });
    expect('permissions' in quiet).toBe(false);
  });

  it('points an issue at the permission it is about', () => {
    const issue = only(steps('- run: echo hi\n  permissions: { pull_requests: admin }'));
    expect(issue.path).toBe('automations[0].steps[0].permissions.pull_requests');
    expect(issue.message).toBe('Expected `read` or `write` for `pull_requests`.');
  });

  it('is refused on an agent step', () => {
    for (const step of [
      '- prompt: Review it.\n  permissions: { pull_requests: write }',
      '- action: Review\n  permissions: { pull_requests: write }',
    ]) {
      const issue = only(steps(step));
      expect(issue.path).toBe('automations[0].steps[0].permissions');
      expect(issue.message).toBe(AGENT_PERMISSIONS_REASON);
    }
  });

  it('is refused on a gate, a call and a loop, each saying why', () => {
    const gate = only(steps('- gate: { ask: Post it? }\n  permissions: { pull_requests: write }'));
    expect(gate.path).toBe('automations[0].steps[0].permissions');
    expect(gate.message).toBe('A gate has no `permissions`: it asks a person and runs nothing.');

    const call = only(
      steps('- uses: consola#list_sessions\n  with: {}\n  permissions: { pull_requests: write }'),
    );
    expect(call.path).toBe('automations[0].steps[0].permissions');
    expect(call.message).toBe(USES_PERMISSIONS_REASON);

    const loop = only(
      steps(
        '- id: polish\n  repeat: { max: 2, until: steps.post.done }\n  permissions: { pull_requests: write }\n  steps:\n    - id: post\n      run: echo "done=true" >> "$CONSOLA_OUTPUT"\n      outputs: { done: boolean }',
      ),
    );
    expect(loop.path).toBe('automations[0].steps[0].permissions');
    expect(loop.message).toBe(LOOP_PERMISSIONS_REASON);
  });

  it('is taken by a run: step inside a loop', () => {
    const result = steps(
      '- id: polish\n  repeat: { max: 2, until: steps.post.done }\n  steps:\n    - id: post\n      run: echo "done=true" >> "$CONSOLA_OUTPUT"\n      outputs: { done: boolean }\n      permissions: { contents: write }',
    );
    expect(result.issues).toEqual([]);
    const [automation] = result.automations;
    if (!automation || !isStepsEntry(automation)) throw new Error('no steps entry');
    const [loop] = automation.steps;
    expect(loop.kind === 'repeat' && (loop.steps[0] as CommandStep).permissions).toEqual({
      contents: 'write',
    });
  });

  it('is refused on an entry', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: a\n    on: { github: { events: [pull_request.opened] } }\n    permissions: { pull_requests: write }\n    steps:\n      - run: echo hi\n',
    );
    const issue = only(result);
    expect(issue.path).toBe('automations[0].permissions');
    expect(issue.message).toBe(ENTRY_PERMISSIONS_REASON);
  });
});
