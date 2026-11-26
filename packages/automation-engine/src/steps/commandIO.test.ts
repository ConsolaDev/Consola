import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isStepsEntry, parseFactorySpec } from '@consola/factory-spec';
import type { OutputType, RunRecord } from '@consola/factory-spec';
import { RunFolder } from '../node/runFolder';
import type { CommandResult } from '../ports';
import {
  OUTPUT_FILE_CAP_BYTES,
  describeFailure,
  layerCommandEnv,
  maskSecrets,
  parseOutputFile,
} from './commandIO';
import { commandSpec, prepareCommand } from './commandStep';
import type { RunDefinition } from './definition';

const VERDICT: OutputType = { type: 'enum', values: ['approve', 'comment', 'request-changes'] };
const COUNT: OutputType = { type: 'integer' };
const NOTE: OutputType = { type: 'string', maxLength: 100 };
const TOKEN = 'gho_abc123';

const parse = (text: string, declared: Record<string, OutputType>, secrets: string[] = []) =>
  parseOutputFile(text, declared, secrets);

function failed(
  text: string,
  declared: Record<string, OutputType>,
  secrets: string[] = [],
): string {
  const parsed = parse(text, declared, secrets);
  if (parsed.ok) throw new Error(`expected a problem, got ${JSON.stringify(parsed.outputs)}`);
  return parsed.problem;
}

describe('maskSecrets', () => {
  it('replaces every occurrence of each secret, the longest first', () => {
    expect(maskSecrets(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe('a *** b ***');
    expect(maskSecrets('gho_abcdef', ['gho_abc', 'gho_abcdef'])).toBe('***');
  });

  it('ignores an empty secret', () => {
    expect(maskSecrets('text', ['', TOKEN])).toBe('text');
  });
});

describe('parseOutputFile', () => {
  it('reads key=value lines, ignoring blank ones', () => {
    expect(
      parse('\nverdict=approve\n\n   \ncount=3\n', { verdict: VERDICT, count: COUNT }),
    ).toEqual({
      ok: true,
      outputs: { verdict: 'approve', count: 3 },
    });
  });

  it('splits at the first =, so a value may hold more', () => {
    expect(parse('note=a=b=c\n', { note: NOTE })).toEqual({ ok: true, outputs: { note: 'a=b=c' } });
  });

  it('strips a trailing CR', () => {
    expect(parse('verdict=comment\r\nnote=x\r\n', { verdict: VERDICT, note: NOTE })).toEqual({
      ok: true,
      outputs: { verdict: 'comment', note: 'x' },
    });
  });

  it('lets the last write win', () => {
    expect(parse('verdict=comment\nverdict=approve\n', { verdict: VERDICT })).toEqual({
      ok: true,
      outputs: { verdict: 'approve' },
    });
  });

  it('takes an empty file when nothing is declared', () => {
    expect(parse('', {})).toEqual({ ok: true, outputs: {} });
  });

  it('has no key<<EOF form', () => {
    expect(failed('verdict<<EOF\napprove\nEOF\n', { verdict: VERDICT })).toMatch(
      /line 1: expected key=value/,
    );
  });

  it('refuses a line with no key', () => {
    expect(failed('verdict=approve\n=approve\n', { verdict: VERDICT })).toMatch(
      /line 2: expected key=value/,
    );
  });

  it('refuses an undeclared key, naming the line', () => {
    const problem = failed('verdict=approve\nscore=3\n', { verdict: VERDICT });
    expect(problem).toMatch(/line 2: score is not an output of this step \(it has: verdict\)/);
    expect(failed('score=3\n', {})).toMatch(
      /line 1: score is not an output of this step \(it declares none\)/,
    );
  });

  it('refuses a bad value, naming the line', () => {
    expect(failed('count=3\nverdict=maybe\n', { verdict: VERDICT, count: COUNT })).toMatch(
      /line 2: verdict: expected one of: approve, comment, request-changes \(got 'maybe'\)/,
    );
    expect(failed('count=three\n', { count: COUNT })).toMatch(/line 1: count: expected an integer/);
  });

  it('fails on a bad line even when a later one would fix it', () => {
    expect(failed('verdict=maybe\nverdict=approve\n', { verdict: VERDICT })).toMatch(
      /line 1: verdict/,
    );
  });

  it('refuses a missing output, naming it', () => {
    expect(failed('verdict=approve\n', { verdict: VERDICT, count: COUNT })).toMatch(
      /without setting count/,
    );
    expect(failed('', { verdict: VERDICT, count: COUNT, note: NOTE })).toMatch(
      /without setting verdict, count and note/,
    );
  });

  it('holds at most 64 KB', () => {
    const declared = {
      note: { type: 'string', maxLength: 2 * OUTPUT_FILE_CAP_BYTES } as OutputType,
    };
    const exactly = 'note=' + 'x'.repeat(OUTPUT_FILE_CAP_BYTES - 'note='.length);
    expect(parse(exactly, declared).ok).toBe(true);
    expect(failed(exactly + 'x', declared)).toMatch(/over 64 KB/);
    // Bytes, not characters: 'é' is two.
    expect(failed('note=' + 'é'.repeat(OUTPUT_FILE_CAP_BYTES / 2), declared)).toMatch(/over 64 KB/);
  });

  describe('keeps the token, and long text, out of a problem', () => {
    it('masks a bad value', () => {
      const problem = failed(`verdict=${TOKEN}\n`, { verdict: VERDICT }, [TOKEN]);
      expect(problem).not.toContain(TOKEN);
      expect(problem).toMatch(/line 1: verdict: expected one of: .* \(got '\*\*\*'\)/);
    });

    it('masks and clips an undeclared key', () => {
      const problem = failed(
        `https://x-access-token:${TOKEN}@github.com/${'o/'.repeat(40)}r?a=b\n`,
        { verdict: VERDICT },
        [TOKEN],
      );
      expect(problem).not.toContain(TOKEN);
      expect(problem).toContain('https://x-access-token:***@github.com/');
      expect(problem).toMatch(/… is not an output of this step/);
      expect(problem.length).toBeLessThan(200);
    });

    it('clips a long value', () => {
      const problem = failed('count=' + 'x'.repeat(60_000) + '\n', { count: COUNT });
      expect(problem).toMatch(/line 1: count: expected an integer \(got 'x+…'\)/);
      expect(problem.length).toBeLessThan(200);
    });

    it('masks before clipping, so no part of a token shows at the cut', () => {
      const problem = failed(`count=${'x'.repeat(60)}${TOKEN}\n`, { count: COUNT }, [TOKEN]);
      expect(problem).not.toContain('gho_');
      expect(problem).toContain(`${'x'.repeat(60)}***`);
    });

    it("says a string's length, not its text", () => {
      const problem = failed(`note=${TOKEN.repeat(20)}\n`, { note: NOTE }, [TOKEN]);
      expect(problem).toMatch(/line 1: note: expected text of at most 100 characters \(got 200\)/);
    });
  });
});

describe('layerCommandEnv', () => {
  it("layers the base, the rendered env:, Consola's variables, then git hooks off", () => {
    const env = layerCommandEnv(
      {
        PATH: '/bin',
        A: 'base',
        GH_TOKEN: 'gho_abc',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 't',
      },
      { A: 'rendered', CONSOLA_STEP: 'forged' },
      { CONSOLA_STEP: 'review', CONSOLA_RUN_ID: 'run-1' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      A: 'rendered',
      GH_TOKEN: 'gho_abc',
      CONSOLA_STEP: 'review',
      CONSOLA_RUN_ID: 'run-1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 't',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
    });
  });

  it("drops a login environment's git folder variables: a command after a write step pushes the run's own clone, never another (3-B code review F5)", () => {
    const env = layerCommandEnv(
      {
        PATH: '/bin',
        GIT_DIR: '/h/other/.git',
        GIT_WORK_TREE: '/h/other',
        GIT_INDEX_FILE: '/h/other/.git/index',
        GIT_COMMON_DIR: '/h/other/.git',
        GIT_OBJECT_DIRECTORY: '/h/other/.git/objects',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '/h/other/.git/objects',
        GIT_AUTHOR_NAME: 'alice',
      },
      {},
      { CONSOLA_BRANCH: 'fix/SHOP-42' },
    );
    for (const name of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    expect(env).toMatchObject({
      PATH: '/bin',
      GIT_AUTHOR_NAME: 'alice',
      CONSOLA_BRANCH: 'fix/SHOP-42',
    });
  });

  it('keeps git hooks off whatever env: says', () => {
    const env = layerCommandEnv(
      {},
      { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.husky' },
      {},
    );
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(env.GIT_CONFIG_VALUE_0).toBe('/dev/null');
  });

  it("layers a step's secrets after its env: and before Consola's variables", () => {
    const base = { PATH: '/bin', X: 'base', PAGER_TOKEN: 'from-the-login-shell' };
    const env = layerCommandEnv(
      base,
      { E: 'env', PAGER_TOKEN: 'from-env' },
      { CONSOLA_RUN_ID: 'r' },
      { PAGER_TOKEN: 'v' },
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      X: 'base',
      E: 'env',
      PAGER_TOKEN: 'v',
      CONSOLA_RUN_ID: 'r',
    });
    expect(Object.keys(env).slice(0, 5)).toEqual([
      'PATH',
      'X',
      'PAGER_TOKEN',
      'E',
      'CONSOLA_RUN_ID',
    ]);
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    // A secret can never be named like Consola's variables: they win either way.
    expect(
      layerCommandEnv({}, {}, { CONSOLA_RUN_ID: 'r' }, { CONSOLA_RUN_ID: 'x' }).CONSOLA_RUN_ID,
    ).toBe('r');
    // Without secrets, exactly today's object.
    expect(layerCommandEnv(base, { E: 'env' }, { CONSOLA_RUN_ID: 'r' })).toEqual(
      layerCommandEnv(base, { E: 'env' }, { CONSOLA_RUN_ID: 'r' }, {}),
    );
    expect(layerCommandEnv(base, { E: 'env' }, { CONSOLA_RUN_ID: 'r' }).PAGER_TOKEN).toBe(
      'from-the-login-shell',
    );
  });
});

describe('describeFailure', () => {
  const result = (fields: Partial<CommandResult>): CommandResult => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stopped: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    ...fields,
  });

  it('names the exit code and the last line of stderr', () => {
    expect(describeFailure(result({ exitCode: 3, lastStderrLine: 'two' }), 600_000)).toBe(
      'exit 3: two',
    );
    expect(describeFailure(result({ exitCode: 1 }), 600_000)).toBe('exit 1');
  });

  it('names a signal the command was killed by', () => {
    expect(
      describeFailure(
        result({ exitCode: null, signal: 'SIGKILL', lastStderrLine: 'oom' }),
        600_000,
      ),
    ).toBe('killed by SIGKILL: oom');
  });

  it('says how long a timed-out command had, as the file writes it', () => {
    const timedOut = result({ exitCode: null, signal: 'SIGTERM', timedOut: true });
    expect(describeFailure(timedOut, 600_000)).toBe('timed out after 10m');
    expect(describeFailure(timedOut, 30_000)).toBe('timed out after 30s');
    expect(describeFailure(timedOut, 90_000)).toBe('timed out after 90s');
    expect(describeFailure(timedOut, 3_600_000)).toBe('timed out after 1h');
    expect(describeFailure(timedOut, 300)).toBe('timed out after 300ms');
  });

  it('says a stopped command may have done its work', () => {
    expect(
      describeFailure(result({ exitCode: null, signal: 'SIGTERM', stopped: true }), 600_000),
    ).toBe('Stopped while running: it may have done its work');
  });
});

describe('prepareCommand in a run that owns its checkout (slice 3-B Task 15)', () => {
  const FACTORY = `version: 1
repos: [sprocket/catalog-portal]
automations:
  - name: write
    on: manual
    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{run.id}}" }
    steps:
      - id: pr
        run: ./pr.sh
`;
  const AT = '2026-11-15T10:00:00.000Z';
  const CHECKOUT = '/w/catalog-portal-run-3f2a91c0';
  let tmp: string;
  let folder: RunFolder;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-owned-'));
    folder = new RunFolder((workspaceId) => path.join(tmp, workspaceId));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function prepared(
    checkout: RunRecord['checkout'],
    trigger: RunRecord['trigger'] = { kind: 'manual', at: AT },
  ) {
    const automation = parseFactorySpec(FACTORY).automations[0];
    if (!automation || !isStepsEntry(automation)) throw new Error('FACTORY does not parse');
    const run: RunRecord = {
      id: '3f2a91c0-aaaa-bbbb-cccc-000000000000',
      runner: 'local',
      source: 'personal',
      automationId: 'write',
      actionName: 'steps',
      actionVersion: 'v1',
      mode: 'auto',
      trigger,
      status: 'running',
      steps: [{ id: 'pr', kind: 'run', status: 'queued', attempt: 1 }],
      ...(checkout ? { checkout } : {}),
      attribution: {
        automationId: 'write',
        actionName: 'steps',
        triggerKind: trigger.kind,
        workspaceId: 'ws-1',
      },
      createdAt: AT,
      updatedAt: AT,
    };
    const result = prepareCommand({
      run,
      definition: { automation, version: 'v1', actions: {} },
      stepId: 'pr',
      cwd: checkout?.cwd ?? CHECKOUT,
      workspaceId: 'ws-1',
      folder,
      source: undefined,
      polled: undefined,
      previous: undefined,
    });
    if (!result.ok) throw new Error(result.error);
    return result.command;
  }

  it("a run-owned run's command gets its branch, base, head and changes, and caches in the checkout, and no git variable (review NB1)", () => {
    const { variables, dir } = prepared({
      cwd: CHECKOUT,
      scopeId: 'scope-portal',
      kind: 'run-owned',
      repo: 'sprocket/catalog-portal',
      branch: 'fix/SHOP-42',
      base: 'b0',
      head: 'c1',
    });
    expect(variables).toMatchObject({
      CONSOLA_BRANCH: 'fix/SHOP-42',
      CONSOLA_BASE: 'b0',
      CONSOLA_CHECKOUT_HEAD: 'c1',
      CONSOLA_CHANGES_FILE: path.join(dir, 'checkout-changes.patch'),
      XDG_CACHE_HOME: `${CHECKOUT}/.consola-cache`,
      npm_config_cache: `${CHECKOUT}/.consola-cache/npm`,
      npm_config_store_dir: `${CHECKOUT}/.consola-cache/pnpm-store`,
      YARN_CACHE_FOLDER: `${CHECKOUT}/.consola-cache/yarn`,
    });
    expect(variables.CONSOLA_CHANGES_FILE).toMatch(/checkout-changes\.patch$/);
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) {
      expect(variables).not.toHaveProperty(name);
    }
  });

  it("any other run's command keeps what it had: its head only when it has one, and nothing of a run's own checkout", () => {
    const item = prepared(
      { cwd: '/w/catalog-portal-pr-51', scopeId: 'scope-portal', kind: 'item', head: 'abc' },
      { kind: 'event', at: AT, item: { key: 'k', url: 'u', title: 't' } },
    ).variables;
    expect(item.CONSOLA_CHECKOUT_HEAD).toBe('abc');
    for (const name of [
      'CONSOLA_BRANCH',
      'CONSOLA_BASE',
      'CONSOLA_CHANGES_FILE',
      'XDG_CACHE_HOME',
      'npm_config_cache',
      'npm_config_store_dir',
      'YARN_CACHE_FOLDER',
    ]) {
      expect(item).not.toHaveProperty(name);
    }
    // The record's kind is the witness: a branch and a base on any other record make it no run's own checkout.
    const named = prepared(
      {
        cwd: '/w/catalog-portal-pr-51',
        scopeId: 'scope-portal',
        kind: 'item',
        head: 'abc',
        branch: 'fix/x',
        base: 'b0',
      },
      { kind: 'event', at: AT, item: { key: 'k', url: 'u', title: 't' } },
    ).variables;
    expect(named).not.toHaveProperty('CONSOLA_BRANCH');
    expect(named).not.toHaveProperty('XDG_CACHE_HOME');
    const scope = prepared({
      cwd: '/code/catalog-portal',
      scopeId: 'scope-portal',
      kind: 'scope',
    }).variables;
    expect(scope).not.toHaveProperty('CONSOLA_CHECKOUT_HEAD');
    expect(scope).not.toHaveProperty('CONSOLA_BRANCH');
  });
});

describe('prepareCommand reading previous', () => {
  /** A review, then a command that posts what changed since the last run's review. */
  const FACTORY = `version: 1
automations:
  - name: review-assigned-prs
    on: { github: pull_request.review_requested }
    steps:
      - id: review
        prompt: Review what changed since your last review.
      - id: publish
        run: ./publish.sh
        env:
          LAST: "{{previous.review.handover}}"
          LAST_FILE: "{{previous.review.handover.file}}"
`;
  const AT = '2026-11-15T10:00:00.000Z';
  let tmp: string;
  let folder: RunFolder;
  let definition: RunDefinition;

  /** This run: its own review completed, having written a handover of its own, and publish next. */
  const run: RunRecord = {
    id: 'run-1',
    runner: 'local',
    source: 'personal',
    automationId: 'review-assigned-prs',
    actionName: 'steps',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: { kind: 'event', at: AT },
    status: 'running',
    steps: [
      {
        id: 'review',
        kind: 'agent',
        status: 'completed',
        attempt: 1,
        artifacts: [{ name: 'handover', bytes: 18 }],
      },
      { id: 'publish', kind: 'run', status: 'queued', attempt: 1 },
    ],
    attribution: {
      automationId: 'review-assigned-prs',
      actionName: 'steps',
      triggerKind: 'event',
      workspaceId: 'ws-1',
    },
    createdAt: AT,
    updatedAt: AT,
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-previous-'));
    folder = new RunFolder((workspaceId) => path.join(tmp, workspaceId));
    const automation = parseFactorySpec(FACTORY).automations[0];
    if (!automation || !isStepsEntry(automation)) throw new Error('FACTORY does not parse');
    definition = { automation, version: 'v1', actions: {} };
    folder.writeArtifact('ws-1', 'run-1', 'review', 1, 'handover', 'This run: no change.');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function values(previous: { runId: string } | undefined): Record<string, string> {
    const prepared = prepareCommand({
      run,
      definition,
      stepId: 'publish',
      cwd: '/code/catalog-portal',
      workspaceId: 'ws-1',
      folder,
      source: undefined,
      polled: undefined,
      previous,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    return Object.fromEntries(prepared.command.values.map(({ name, value }) => [name, value]));
  }

  it('{{previous.review.handover}} renders the content', () => {
    folder.writeArtifact(
      'ws-1',
      'run-0',
      'review',
      1,
      'handover',
      'Last run: line 40 retries forever.',
    );
    expect(values({ runId: 'run-0' }).LAST).toBe('Last run: line 40 retries forever.');
  });

  it(".file renders the earlier run's absolute file", () => {
    folder.writeArtifact('ws-1', 'run-0', 'review', 1, 'handover', 'First look.');
    folder.writeArtifact('ws-1', 'run-0', 'review', 2, 'handover', 'Second look.');
    const file = values({ runId: 'run-0' }).LAST_FILE;
    expect(file).toBe(folder.artifactPath('ws-1', 'run-0', 'review', 2, 'handover'));
    expect(path.isAbsolute(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('Second look.');
  });

  it("absent renders as ''", () => {
    // No earlier run, though this run's own review wrote a handover.
    expect(values(undefined)).toEqual({ LAST: '', LAST_FILE: '' });
    // An earlier run that wrote none.
    expect(values({ runId: 'run-0' })).toEqual({ LAST: '', LAST_FILE: '' });
  });

  it('a hostile value stays data', () => {
    const hostile = '$(touch pwned)`touch pwned2`; {{item.url}}';
    folder.writeArtifact('ws-1', 'run-0', 'review', 1, 'handover', hostile);
    const prepared = prepareCommand({
      run,
      definition,
      stepId: 'publish',
      cwd: tmp,
      workspaceId: 'ws-1',
      folder,
      source: undefined,
      polled: undefined,
      previous: { runId: 'run-0' },
    });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.command.values.find((value) => value.name === 'LAST')?.value).toBe(hostile);
    const spec = commandSpec(prepared.command, { env: {}, secrets: [] });
    expect(spec.command).toBe('./publish.sh');
    expect(spec.env.LAST).toBe(hostile);
    expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
  });
});
