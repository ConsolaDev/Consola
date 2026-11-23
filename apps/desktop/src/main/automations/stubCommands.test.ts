import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

/*
 * The stub commands §4.1's end-to-end spec runs (slice 3-B Task 23): `gh pr
 * create`, which records the pull request it would open, and `acli`, which
 * lists the Jira items a poll reads and logs each comment and transition.
 * Neither reaches a network.
 */

const FIXTURES = path.resolve(__dirname, '../../../tests/fixtures');
const GH = path.join(FIXTURES, 'stub-gh', 'gh');
const ACLI = path.join(FIXTURES, 'stub-acli', 'acli');

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-commands-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const run = (file: string, args: string[], env: Record<string, string>) =>
  spawnSync(file, args, { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

describe('stub gh pr create', () => {
  it('prints the pull request it opened and records its head, title and body', () => {
    const dir = scratch();
    const created = path.join(dir, 'created.jsonl');
    const body = path.join(dir, 'body.md');
    fs.writeFileSync(body, 'The search box no longer clips.\n\nTested with `pnpm test`.\n');
    const { stdout, status } = run(
      GH,
      [
        'pr',
        'create',
        '--head',
        'fix/SHOP-42',
        '--title',
        'SHOP-42: Search box clips',
        '--body-file',
        body,
      ],
      { STUB_GH_CREATED: created },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('https://github.com/sprocket/catalog-portal/pull/77\n');
    const lines = fs.readFileSync(created, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        head: 'fix/SHOP-42',
        title: 'SHOP-42: Search box clips',
        body: 'The search box no longer clips.\n\nTested with `pnpm test`.\n',
      },
    ]);
  });
});

describe('stub gh pr create refuses what it does not stand in for', () => {
  it('an unknown flag, or a missing one, exits 64 and records nothing', () => {
    const dir = scratch();
    const created = path.join(dir, 'created.jsonl');
    const body = path.join(dir, 'body.md');
    fs.writeFileSync(body, 'Body.\n');
    const unknown = run(
      GH,
      ['pr', 'create', '--head', 'fix/SHOP-42', '--title', 't', '--body-file', body, '--draft'],
      { STUB_GH_CREATED: created },
    );
    expect(unknown.status).toBe(64);
    expect(unknown.stderr).toBe('stub gh: unhandled argv: pr create ... --draft\n');
    const missing = run(GH, ['pr', 'create', '--head', 'fix/SHOP-42', '--title', 't'], {
      STUB_GH_CREATED: created,
    });
    expect(missing.status).toBe(64);
    expect(missing.stderr).toBe('stub gh: pr create needs --head, --title and --body-file\n');
    expect(fs.existsSync(created)).toBe(false);
  });
});

describe('stub acli', () => {
  it('lists the items its file holds for a search', () => {
    const dir = scratch();
    const items = path.join(dir, 'items.json');
    fs.writeFileSync(items, JSON.stringify([{ key: 'SHOP-42', title: 'Search box clips' }]));
    const { stdout, status } = run(
      ACLI,
      ['jira', 'workitem', 'search', '--json', '--jql', 'project = SHOP AND type = Bug'],
      { STUB_ACLI_ITEMS: items },
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ key: 'SHOP-42', title: 'Search box clips' }]);
  });

  it('logs each comment and transition, one line each', () => {
    const dir = scratch();
    const log = path.join(dir, 'acli.log');
    const env = { STUB_ACLI_LOG: log };
    expect(
      run(
        ACLI,
        ['jira', 'workitem', 'comment', 'create', '--key', 'SHOP-42', '--body', 'Not a UI bug.'],
        env,
      ).status,
    ).toBe(0);
    expect(
      run(
        ACLI,
        ['jira', 'workitem', 'transition', '--key', 'SHOP-42', '--status', 'In Review'],
        env,
      ).status,
    ).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toBe(
      'comment SHOP-42 Not a UI bug.\ntransition SHOP-42 In Review\n',
    );
  });

  it('refuses anything else, naming it', () => {
    const { stderr, status } = run(ACLI, ['jira', 'workitem', 'delete', '--key', 'SHOP-42'], {});
    expect(status).toBe(64);
    expect(stderr).toBe('stub acli: unhandled argv: jira workitem delete --key SHOP-42\n');
  });
});
