import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubDriver } from './GitHubDriver';
import type { WorkItemMutation } from '../../../shared/workItemDetails';

const fixture = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');
const ref = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 } as const;
let dir: string;
let previous: string | undefined;
let driver: GitHubDriver;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-details-'));
  previous = process.env.CONSOLA_GH_PATH;
  process.env.CONSOLA_GH_PATH = fixture;
  env = { PATH: process.env.PATH, GH_TOKEN: 'stub-workspace-account', STUB_GH_LOG: path.join(dir, 'argv') };
  driver = new GitHubDriver(() => env);
});
afterEach(() => {
  if (previous === undefined) delete process.env.CONSOLA_GH_PATH;
  else process.env.CONSOLA_GH_PATH = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});
const log = () => fs.readFileSync(path.join(dir, 'argv'), 'utf8');

describe('GitHub item details and actions', () => {
  it('loads paginated conversation, review feedback, files, and both check formats', async () => {
    const details = await driver.fetchDetails(ref, env);
    expect(details.comments.map((comment) => comment.kind)).toEqual(['comment', 'review', 'inline']);
    expect(details.comments[2]).toMatchObject({ path: 'src/billing.ts', line: 12 });
    expect(details.files[0].patch).toContain('+new');
    expect(details.checks.map((check) => check.state)).toEqual(['FAILURE', 'SUCCESS']);
    expect(details.state).toBe('open');
    expect(log().match(/--paginate --slurp/g)).toHaveLength(4);
    expect(log()).toContain('--repo github.com/sprocket/catalog-portal');
  });
  it('issues do not request pull-request-only data', async () => {
    const details = await driver.fetchDetails({ ...ref, type: 'issue' }, env);
    expect(details.files).toEqual([]);
    expect(details.comments).toHaveLength(1);
    expect(log()).not.toContain('/pulls/');
  });
  it('sends each explicit action to the correct repo without bypassing rules', async () => {
    const actions: WorkItemMutation[] = [
      { kind: 'comment', body: 'A multiline\ncomment with `code` and $(literal)' },
      { kind: 'edit', title: 'New title', body: 'Description' },
      { kind: 'review', event: 'approve', body: '' },
      { kind: 'review', event: 'request-changes', body: 'Add tests' },
      { kind: 'close' }, { kind: 'reopen' }, { kind: 'ready', draft: true },
      { kind: 'merge', method: 'squash', headOid: 'a'.repeat(40), auto: true },
    ];
    for (const action of actions) await driver.mutateItem(ref, action, env);
    expect(log()).toContain('--body A multiline comment with `code` and $(literal)');
    expect(log()).toContain('--approve');
    expect(log()).toContain('--request-changes --body Add tests');
    expect(log()).toContain('--undo');
    expect(log()).toContain(`--squash --match-head-commit ${'a'.repeat(40)} --auto`);
    expect(log()).not.toContain('--admin');
    expect(log().match(/GH_TOKEN=stub-workspace-account/g)).toHaveLength(actions.length);
  });
  it('rejects reviews on issues and empty change requests before spawning', async () => {
    await expect(driver.mutateItem({ ...ref, type: 'issue' }, { kind: 'review', event: 'approve', body: '' }, env)).rejects.toThrow('pull request');
    await expect(driver.mutateItem(ref, { kind: 'review', event: 'request-changes', body: '' }, env)).rejects.toThrow('required');
    expect(fs.existsSync(path.join(dir, 'argv'))).toBe(false);
  });
  it('surfaces provider rejection for a write', async () => {
    const failure = path.join(dir, 'fail'); fs.writeFileSync(failure, '');
    await expect(driver.mutateItem(ref, { kind: 'close' }, { ...env, STUB_GH_MUTATION_FAILURE_FILE: failure })).rejects.toThrow('repository rules');
  });
});
