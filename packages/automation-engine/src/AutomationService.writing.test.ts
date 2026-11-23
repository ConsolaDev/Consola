import {
  automationVersion,
  cleanBranchPart,
  factoryFilesOf,
  parseFactory,
  parseFactorySpec,
} from '@consola/factory-spec';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEYCHAIN_SENTENCE } from './describeEntry';
import { fileVersion } from './factory/apply';
import { inboxItem } from './inboxItems.test-helpers';
import { INTERRUPTED_WRITE } from './steps/recover';
import { NO_RUN_CHECKOUTS, RunCheckoutError } from './steps/runCheckout';
import {
  checkoutPathFor,
  runCheckoutPathFor,
  stepsHarness,
  WORKSPACE_ID,
  type StepsHarness,
  type StepsHarnessOptions,
} from './steps/steps.test-helpers';

/*
 * Slice 3-B, writing: a run with `checkout: { repo, branch }` works in a
 * checkout of its own, which the engine has the host make before its first
 * step (Task 12), settle and commit after every step (Task 13), and hold
 * against a person's session (Task 14). The host's git work is the fake
 * `RunCheckoutPort` (`runCheckouts: true`).
 */

const REPO = 'sprocket/catalog-portal';
const file = (...entries: string[]) =>
  `version: 1\nrepos: [${REPO}]\nautomations:\n${entries.join('')}`;
const steps = (...items: string[]) =>
  `    steps:\n${items.map((item) => `      ${item.replace(/\n/g, '\n      ')}`).join('\n')}\n`;
const owned = (branch: string) => `    checkout: { repo: ${REPO}, branch: "${branch}" }\n`;

/** `on: manual`, its own checkout, one command. */
const RUN_OWNED = file(
  `  - name: own\n    on: manual\n    mode: auto\n${owned('consola/run-{{run.id}}')}${steps('- id: check\n  run: "true"')}`,
);
/** A keyed poll whose items become branches. */
const POLL_OWNED = file(
  `  - name: poll-own\n    on:\n      poll: { every: 5m, run: ./list, key: .key }\n    mode: auto\n${owned('fix/{{item.key}}')}${steps('- id: check\n  run: "true"\n  env: { KEY: "{{item.key}}" }')}`,
);
/** An event on pull requests, its own checkout. */
const EVENT_OWNED = file(
  `  - name: on-pr\n    on: { github: pull_request.review_requested }\n    mode: auto\n${owned('fix/pr-{{item.number}}')}${steps('- id: check\n  run: "true"')}`,
);

/** Accept every entry in `yaml` at its version, as a person approving each once would, and allow its checks. */
function acceptEvery(h: StepsHarness, yaml: string): void {
  for (const automation of parseFactorySpec(yaml).automations)
    h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation));
  for (const view of h.service.list(WORKSPACE_ID))
    if (view.needsAllow && view.version) h.service.allow(WORKSPACE_ID, view.name, view.version);
}

async function harness(yaml: string, options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  const h = await stepsHarness({ yaml, runCheckouts: true, ...options });
  acceptEvery(h, yaml);
  await h.flush();
  return h;
}
const problemOf = (h: StepsHarness, name: string) =>
  h.service.list(WORKSPACE_ID).find((view) => view.name === name)?.problem;
const runNow = async (h: StepsHarness, name: string) => {
  const run = await h.service.trigger(WORKSPACE_ID, name);
  await h.flush();
  return run!;
};
const runOf = (h: StepsHarness, id: string) => h.store.get(id)!;
const makes = (h: StepsHarness) =>
  h.world.runCheckouts.calls.flatMap((call) => ('make' in call ? [call.make] : []));
/** The commands steps started (a poll's own check is the other kind). */
const stepCommands = (h: StepsHarness) =>
  h.world.commands.filter((command) => command.spec.env.CONSOLA_STEP !== undefined);
/** A poll check that prints `items`, then whatever it set going. */
async function check(h: StepsHarness, name: string, items: Array<{ key: string }>) {
  await h.service.trigger(WORKSPACE_ID, name);
  await h.flush();
  const pending = h.world.commands.filter(
    (command) => !command.ended && command.spec.env.CONSOLA_STEP === undefined,
  );
  await pending[pending.length - 1].end({ stdout: JSON.stringify(items) });
  await h.flush();
}
const lastCheck = (h: StepsHarness, name: string) =>
  h.service.list(WORKSPACE_ID).find((view) => view.name === name)?.check;

describe('a run that owns its checkout makes it before its first step (Task 12)', () => {
  it('makes the checkout before the first step, and records it', async () => {
    const h = await harness(RUN_OWNED);
    const run = await runNow(h, 'own');
    const branch = `consola/run-${run.id.slice(0, 8)}`;
    expect(makes(h)).toEqual([
      { workspaceId: WORKSPACE_ID, runId: run.id, automation: 'own', repo: REPO, branch },
    ]);
    expect(runOf(h, run.id).checkout).toEqual({
      cwd: runCheckoutPathFor(run.id, REPO),
      scopeId: 'scope-catalog-portal',
      kind: 'run-owned',
      repo: REPO,
      branch,
      base: 'b0',
      head: 'b0',
    });
    expect(stepCommands(h)[0].spec.cwd).toBe(runCheckoutPathFor(run.id, REPO));
    // Its command reads the run's head, as an item run's does (Task 13).
    expect(stepCommands(h)[0].spec.env.CONSOLA_CHECKOUT_HEAD).toBe('b0');
  });

  it('a poll item becomes its branch, cleaned', async () => {
    const h = await harness(POLL_OWNED);
    // A first check is a baseline: it fires nothing.
    await check(h, 'poll-own', []);
    await check(h, 'poll-own', [{ key: 'SHOP-42' }, { key: '../x' }]);
    expect(
      makes(h)
        .map((made) => made.branch)
        .sort(),
    ).toEqual(['fix/SHOP-42', `fix/${cleanBranchPart('../x')}`].sort());
    expect(cleanBranchPart('../x')).not.toContain('..');
  });

  it('two runs of one entry each get their own folder and branch; Run now while one is open is that run', async () => {
    const h = await harness(POLL_OWNED);
    await check(h, 'poll-own', []);
    await check(h, 'poll-own', [{ key: 'SHOP-42' }, { key: 'SHOP-43' }]);
    expect(
      makes(h)
        .map((made) => made.branch)
        .sort(),
    ).toEqual(['fix/SHOP-42', 'fix/SHOP-43']);
    const folders = h.store.runs().map((run) => run.checkout?.cwd);
    expect(new Set(folders).size).toBe(2);
    const own = await harness(RUN_OWNED);
    const first = await runNow(own, 'own');
    expect((await runNow(own, 'own')).id).toBe(first.id);
    expect(makes(own)).toHaveLength(1);
  });

  it('a host with no RunCheckoutPort refuses the entry in words, and runs nothing (Call 2)', async () => {
    const plain = await stepsHarness({ yaml: RUN_OWNED });
    expect(problemOf(plain, 'own')).toBe(NO_RUN_CHECKOUTS);
    await expect(plain.service.trigger(WORKSPACE_ID, 'own')).rejects.toThrow(/cannot run/);
    expect(plain.store.runs()).toEqual([]);
  });

  it('a checkout that cannot be made fails the run before its first step, saying which', async () => {
    const h = await harness(RUN_OWNED);
    h.world.runCheckouts.makeFails = new RunCheckoutError('fetch', 'could not read from remote');
    const run = await runNow(h, 'own');
    expect(runOf(h, run.id)).toMatchObject({
      status: 'failed',
      error:
        "Couldn't make this run's checkout of sprocket/catalog-portal (fetch): could not read from remote. Nothing was changed; retry once it can be made.",
    });
    expect(
      runOf(h, run.id).steps!.every(
        (step) => step.status === 'pending' || step.status === 'not-run',
      ),
    ).toBe(true);
    expect(stepCommands(h)).toEqual([]);
    // Its claim names the folder it would have made, and no commit.
    expect(runOf(h, run.id).checkout).toEqual({
      cwd: runCheckoutPathFor(run.id, REPO),
      kind: 'run-owned',
      repo: REPO,
    });
  });

  it('a retry of a run whose checkout was never made makes it at a fresh base; one that was made keeps its record', async () => {
    const h = await harness(RUN_OWNED);
    h.world.runCheckouts.makeFails = new RunCheckoutError('fetch', 'offline');
    const never = await runNow(h, 'own');
    h.world.runCheckouts.makeFails = undefined;
    h.world.runCheckouts.base = 'b1';
    await h.service.retry(never.id);
    await h.flush();
    expect(runOf(h, never.id).checkout).toMatchObject({
      kind: 'run-owned',
      base: 'b1',
      head: 'b1',
    });
    expect(makes(h)).toHaveLength(2);

    const made = await harness(RUN_OWNED);
    const run = await runNow(made, 'own');
    await stepCommands(made)[0].end({ result: { exitCode: 1 } });
    expect(runOf(made, run.id).status).toBe('failed');
    made.world.runCheckouts.base = 'b9';
    await made.service.retry(run.id);
    await made.flush();
    expect(makes(made)).toHaveLength(1);
    expect(runOf(made, run.id).checkout).toMatchObject({ base: 'b0', head: 'b0' });
    expect(stepCommands(made)).toHaveLength(2);
    expect(stepCommands(made)[1].spec.cwd).toBe(runCheckoutPathFor(run.id, REPO));
  });

  it("a run on a pull request that owns its checkout never prepares the item's, at its start or a retry", async () => {
    const h = await harness(EVENT_OWNED);
    // A first Inbox fetch is a baseline: it fires nothing.
    await h.poll([]);
    await h.poll([inboxItem({ repo: REPO, number: 51 })]);
    const [run] = h.store.runs();
    expect(makes(h)).toEqual([expect.objectContaining({ branch: 'fix/pr-51', runId: run.id })]);
    expect(runOf(h, run.id).checkout?.kind).toBe('run-owned');
    await stepCommands(h)[0].end({ result: { exitCode: 1 } });
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.checkouts.prepared).toEqual([]);
    expect(runOf(h, run.id).checkout?.kind).toBe('run-owned');
  });

  it("a retry of an agent step never prepares the item's checkout for a run that owns its own", async () => {
    const yaml = EVENT_OWNED.replace(
      '- id: check\n        run: "true"',
      '- id: look\n        prompt: Look at it.',
    );
    expect(yaml).toContain('prompt: Look at it.');
    const h = await harness(yaml);
    await h.poll([]);
    await h.poll([inboxItem({ repo: REPO, number: 51 })]);
    const [run] = h.store.runs();
    expect(h.world.launches).toHaveLength(1);
    await h.world.endTurn('session-1', { exitCode: 1 });
    expect(runOf(h, run.id).status).toBe('failed');
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.checkouts.prepared).toEqual([]);
    expect(h.world.launches).toHaveLength(2);
    expect(h.world.launches[1].step?.cwd).toBe(runCheckoutPathFor(run.id, REPO));
  });

  it("neither its start nor a retry waits for the item's own checkout, which it never uses", async () => {
    const h = await harness(EVENT_OWNED);
    const item = inboxItem({ repo: REPO, number: 51 });
    // A person's session works in the item's checkout: a run that owns its checkout does not care.
    h.world.busyFolders.add(checkoutPathFor(item.workItem));
    await h.poll([]);
    await h.poll([item]);
    const [run] = h.store.runs();
    expect(runOf(h, run.id).status).toBe('running');
    expect(stepCommands(h)).toHaveLength(1);
    await stepCommands(h)[0].end({ result: { exitCode: 1 } });
    await expect(h.service.retry(run.id)).resolves.toMatchObject({ status: 'running' });
  });

  it('Run on… is refused when checkout.repo is not cloned; a poll skips and counts, marking none', async () => {
    const h = await harness(POLL_OWNED);
    await check(h, 'poll-own', [{ key: 'SHOP-41' }]);
    h.world.repoCloned = () => false;
    await expect(
      h.service.trigger(WORKSPACE_ID, 'poll-own', {}, { key: 'SHOP-41' }),
    ).rejects.toThrow('sprocket/catalog-portal is not cloned in this workspace.');
    const before = h.store.runs().length;
    await check(h, 'poll-own', [{ key: 'SHOP-41' }, { key: 'SHOP-42' }]);
    expect(lastCheck(h, 'poll-own')).toMatchObject({ fired: 0, skipped: 2 });
    expect(h.store.runs()).toHaveLength(before);
    h.world.repoCloned = () => true;
    await check(h, 'poll-own', [{ key: 'SHOP-41' }, { key: 'SHOP-42' }]);
    expect(lastCheck(h, 'poll-own')).toMatchObject({ fired: 1, skipped: 0 });
  });

  it('Run now and an event are refused the same way while it is not cloned', async () => {
    const own = await harness(RUN_OWNED);
    own.world.repoCloned = () => false;
    await expect(own.service.trigger(WORKSPACE_ID, 'own')).rejects.toThrow(
      'sprocket/catalog-portal is not cloned in this workspace.',
    );
    expect(own.store.runs()).toEqual([]);
    const event = await harness(EVENT_OWNED);
    event.world.repoCloned = () => false;
    await event.poll([inboxItem({ repo: REPO, number: 51 })]);
    expect(event.store.runs()).toEqual([]);
    event.world.repoCloned = () => true;
    await event.poll([inboxItem({ repo: REPO, number: 51 })]);
    expect(event.store.runs()).toHaveLength(1);
  });

  it('an item run records kind item, a scope run kind scope', async () => {
    const h = await stepsHarness({
      yaml: `version: 1\nautomations:\n  - name: on-pr\n    on: { github: pull_request.review_requested }\n    mode: auto\n${steps('- id: check\n  run: "true"')}  - name: daily\n    on: manual\n    scope: api\n    mode: auto\n${steps('- id: check\n  run: "true"')}`,
    });
    acceptEvery(h, h.texts().get('factory.yml')!);
    await h.poll([]);
    await h.poll([inboxItem({ repo: REPO, number: 51 })]);
    await runNow(h, 'daily');
    const kinds = Object.fromEntries(
      h.store.runs().map((run) => [run.automationId, run.checkout?.kind]),
    );
    expect(kinds).toEqual({ 'on-pr': 'item', daily: 'scope' });
  });

  it('a dry run still makes the checkout, for its read-only steps', async () => {
    const h = await harness(RUN_OWNED.replace('mode: auto', 'mode: notify'));
    const run = await runNow(h, 'own');
    expect(makes(h)).toHaveLength(1);
    expect(runOf(h, run.id)).toMatchObject({
      dryRun: true,
      checkout: { kind: 'run-owned', base: 'b0' },
    });
  });

  it('a restart before the checkout was made makes it then', async () => {
    const h = await harness(RUN_OWNED);
    // The first make never returns: Consola quits while it is under way.
    h.world.runCheckouts.makeGate = new Promise<void>(() => undefined);
    const run = (await h.service.trigger(WORKSPACE_ID, 'own'))!;
    await h.flush();
    expect(runOf(h, run.id)).toMatchObject({ status: 'running', checkout: { kind: 'run-owned' } });
    expect(runOf(h, run.id).checkout?.base).toBeUndefined();
    h.world.runCheckouts.makeGate = undefined;
    const again = await h.relaunch();
    await again.flush();
    expect(makes(again)).toHaveLength(2);
    expect(runOf(again, run.id).checkout).toMatchObject({
      kind: 'run-owned',
      base: 'b0',
      head: 'b0',
    });
    expect(stepCommands(again)).toHaveLength(1);
  });
});

/** A write agent on `sandbox`, and the environment it names. */
const WRITER = {
  'agents/fixer.md': '---\ntools: write\nenvironment: sandboxed\n---\nFix it.\n',
  'environments/sandboxed.yaml': 'isolation: sandbox\n',
};
/** `on: manual`, its own checkout: `fix` runs the write agent, then `pr` a command. */
const WRITE_ENTRY = file(
  `  - name: write\n    on: manual\n    mode: auto\n${owned('fix/{{run.id}}')}${steps('- id: fix\n  agent: fixer\n  prompt: Fix it.', '- id: pr\n  run: "true"')}`,
);
/** A keyed poll: `fix` writes `notes` into the checkout at a path named by the item. */
const POLL_WRITE = file(
  `  - name: poll-write\n    on:\n      poll: { every: 5m, run: ./list, key: .key }\n    mode: auto\n${owned('fix/{{item.key}}')}${steps('- id: fix\n  agent: fixer\n  prompt: Fix it.\n  artifacts: [{ name: notes, path: "docs/fixes/{{item.key}}.md" }]', '- id: pr\n  run: "true"')}`,
);

/** The version the folder's files give an entry, agents and environments included: its resolved one, with no action bodies. */
function versionOf(h: StepsHarness, name: string): string {
  const parsed = parseFactory(factoryFilesOf(Object.fromEntries(h.texts())));
  const entry = parsed.automations.find((automation) => automation.name === name)!;
  return fileVersion(entry, parsed.agents, parsed.environments);
}
/** Accept every entry the service lists at that version, as a person approving each once would, and allow its checks. */
function acceptListed(h: StepsHarness): void {
  for (const view of h.service.list(WORKSPACE_ID)) {
    h.store.accept(`${WORKSPACE_ID} ${view.name}`, versionOf(h, view.name));
    if (view.needsAllow && view.version) h.service.allow(WORKSPACE_ID, view.name, view.version);
  }
}
async function writing(
  yaml: string,
  options: StepsHarnessOptions = {},
  files: Record<string, string> = WRITER,
): Promise<StepsHarness> {
  const h = await stepsHarness({ yaml, files, runCheckouts: true, ...options });
  acceptListed(h);
  await h.flush();
  return h;
}
const stepOf = (h: StepsHarness, runId: string, id: string) =>
  runOf(h, runId).steps!.find((step) => step.id === id)!;
/** The name of each port call after the first `skip` (folder checks are kept apart). */
const callNames = (h: StepsHarness, skip = 0) =>
  h.world.runCheckouts.calls.slice(skip).map((call) => Object.keys(call)[0]);
const settles = (h: StepsHarness) =>
  h.world.runCheckouts.calls.flatMap((call) => ('settle' in call ? [call.settle] : []));
const ownedDir = (h: StepsHarness, runId: string) => runOf(h, runId).checkout!.cwd;
/** The session of the latest launch: a step's turn ends there. */
const lastSession = (h: StepsHarness) => `session-${h.world.launches.length}`;

describe("every step in a run's checkout ends with Consola's checks and commit (Task 13)", () => {
  it("an agent step ends with Consola's commit, recorded on the step and the run, before the next step starts", async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    expect(h.world.launches).toHaveLength(1);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'running',
      tools: 'write',
      checkout: { before: 'b0' },
    });
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(callNames(h)).toEqual([
      'make',
      'settleBetween',
      'endStepProcesses',
      'settle',
      'settleBetween',
    ]);
    expect(settles(h)[0]).toEqual({
      dir: ownedDir(h, run.id),
      branch: `fix/${run.id.slice(0, 8)}`,
      base: 'b0',
      before: 'b0',
      step: 'fix',
      commit: { message: `fix (attempt 1) of write on ${run.id.slice(0, 8)}` },
      attemptDir: h.folder.attemptDir(WORKSPACE_ID, run.id, 'fix', 1),
    });
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'completed',
      tools: 'write',
      checkout: { before: 'b0', after: 'c1', files: 2, flagged: [] },
    });
    expect(runOf(h, run.id).checkout!.head).toBe('c1');
    // The next step starts only once the commit is recorded, and its command reads it.
    expect(stepCommands(h)).toHaveLength(1);
    expect(stepCommands(h)[0].spec.env.CONSOLA_CHECKOUT_HEAD).toBe('c1');
  });

  it("the step's own processes are ended, asked by its session; one that survives fails the step, and nothing is settled", async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.processes.end = { kind: 'survivors', count: 1 };
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    const asked = h.world.runCheckouts.calls.find((call) => 'endStepProcesses' in call);
    expect(asked).toEqual({
      endStepProcesses: { dir: ownedDir(h, run.id), sessionId: 'session-1' },
    });
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'failed',
      error: 'a process the step started is still running in the checkout',
    });
    expect(stepOf(h, run.id, 'pr').status).toBe('not-run');
    expect(settles(h)).toEqual([]);
    expect(stepCommands(h)).toEqual([]);
  });

  it("a process outside Consola's sessions fails the step, naming it, and nothing settles (reviews B6, NS2)", async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.processes.end = { kind: 'strangers', processes: [{ pid: 4242, command: 'node' }] };
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(stepOf(h, run.id, 'fix').error).toBe(
      "a process outside Consola's sessions is running in this run's checkout (node, pid 4242); end it, then retry",
    );
    expect(settles(h)).toEqual([]);
  });

  it('a process check that cannot be read fails the step, and nothing settles', async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.processes.end = { kind: 'unknown', why: 'lsof: not found' };
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(stepOf(h, run.id, 'fix').error).toBe(
      "Consola couldn't check for processes left in the checkout: lsof: not found",
    );
    expect(settles(h)).toEqual([]);
  });

  it('the next spawn checks the git folder first: a changed one fails that step before it starts, and nothing is spawned (review NB1)', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    // Rewritten after fix launched, before pr spawns.
    h.world.folderProblem = () => ".git in the checkout is not Consola's pointer";
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(stepOf(h, run.id, 'pr')).toMatchObject({
      status: 'failed',
      error:
        "the git folder of this run's checkout changed (.git in the checkout is not Consola's pointer), so Consola will not start anything in it",
    });
    expect(stepCommands(h)).toEqual([]);
    // fix's launch, then pr's spawn.
    expect(h.world.runCheckouts.folderChecks).toEqual([ownedDir(h, run.id), ownedDir(h, run.id)]);
  });

  it('an agent step whose git folder changed before it starts is never launched', async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.folderProblem = () => '`config` changed';
    const run = await runNow(h, 'write');
    expect(h.world.launches).toEqual([]);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'failed',
      error:
        "the git folder of this run's checkout changed (`config` changed), so Consola will not start anything in it",
    });
    expect(stepOf(h, run.id, 'fix').startedAt).toBeUndefined();
    expect(runOf(h, run.id).status).toBe('failed');
  });

  it('a command step asks with no session, is checked and not committed, and its own commit moves the head', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    // While it runs, its row says the commit its checks start from.
    expect(stepOf(h, run.id, 'pr')).toMatchObject({
      status: 'running',
      checkout: { before: 'c1' },
    });
    h.world.runCheckouts.settleAnswers = [{ ok: true, after: 'p1', files: 1, flagged: [] }];
    await stepCommands(h)[0].end();
    expect(h.world.runCheckouts.calls.slice(5)).toEqual([
      { endStepProcesses: { dir: ownedDir(h, run.id) } },
      {
        settle: expect.objectContaining({ step: 'pr', before: 'c1', commit: null }),
      },
    ]);
    expect(stepOf(h, run.id, 'pr')).toMatchObject({
      status: 'completed',
      checkout: { before: 'c1', after: 'p1', files: 1, flagged: [] },
    });
    expect(runOf(h, run.id)).toMatchObject({ status: 'completed', checkout: { head: 'p1' } });
  });

  it("a command that leaves files fails with the check's words", async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    h.world.runCheckouts.settleAnswers = [{ ok: false, error: '`pr` left files changed: x' }];
    await stepCommands(h)[0].end();
    expect(stepOf(h, run.id, 'pr')).toMatchObject({
      status: 'failed',
      error: '`pr` left files changed: x',
    });
    expect(runOf(h, run.id).checkout!.head).toBe('c1');
  });

  it("a command's checks wait for its process group to end", async () => {
    const h = await writing(WRITE_ENTRY);
    let ended!: () => void;
    h.world.commandGroupEnded = new Promise<void>((resolve) => (ended = resolve));
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    await stepCommands(h)[0].end();
    expect(callNames(h, 5)).toEqual([]);
    expect(stepOf(h, run.id, 'pr').status).toBe('running');
    ended();
    await h.flush();
    expect(callNames(h, 5)).toEqual(['endStepProcesses', 'settle']);
    expect(stepOf(h, run.id, 'pr').status).toBe('completed');
  });

  it('a failed settle fails the step with its words, and nothing after it runs', async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.runCheckouts.settleAnswers = [
      { ok: false, error: `the step moved \`HEAD\` off fix/x` },
    ];
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'failed',
      error: 'the step moved `HEAD` off fix/x',
    });
    expect(stepOf(h, run.id, 'pr').status).toBe('not-run');
    expect(runOf(h, run.id).checkout!.head).toBe('b0');
    expect(stepCommands(h)).toEqual([]);
  });

  it('a failed turn keeps its own error, and its changes are kept as a patch, nothing committed', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(callNames(h)).toEqual(['make', 'settleBetween', 'endStepProcesses', 'settle']);
    expect(settles(h)[0]).toMatchObject({ before: 'b0', commit: null, keepOnly: true });
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'failed',
      error: 'It stopped before finishing (exit 1): Rate limited.',
    });
    expect(stepOf(h, run.id, 'fix').checkout).toEqual({ before: 'b0' });
    expect(runOf(h, run.id).checkout!.head).toBe('b0');
  });

  it('a failed turn that left a process keeps the patch for its retry: nothing is settled', async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.processes.end = { kind: 'survivors', count: 1 };
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(settles(h)).toEqual([]);
    expect(stepOf(h, run.id, 'fix').error).toBe(
      'It stopped before finishing (exit 1): Rate limited.',
    );
  });

  it('a path artifact is read at the commit the step ended at; missing, one reminder naming its path, then it is read', async () => {
    const h = await writing(POLL_WRITE);
    h.world.runCheckouts.showAnswers = [
      { ok: false, reason: 'missing' },
      { ok: true, text: '# notes' },
    ];
    await check(h, 'poll-write', []);
    await check(h, 'poll-write', [{ key: 'SHOP-42' }]);
    const [run] = h.store.runs().filter((candidate) => candidate.automationId === 'poll-write');
    // `notes` is a file in the checkout: the step tools' missing documents do not hold the step before the commit.
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    expect(callNames(h)).toEqual(['make', 'settleBetween', 'endStepProcesses', 'settle', 'showAt']);
    expect(h.world.reminders).toHaveLength(1);
    expect(h.world.reminders[0].prompt).toContain(
      'notes (the file docs/fixes/SHOP-42.md in this checkout)',
    );
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    expect(
      h.world.runCheckouts.calls.flatMap((call) => ('showAt' in call ? [call.showAt] : [])),
    ).toEqual([
      {
        dir: ownedDir(h, run.id),
        commit: 'c1',
        path: 'docs/fixes/SHOP-42.md',
        maxBytes: 1024 * 1024,
      },
      {
        dir: ownedDir(h, run.id),
        commit: 'c1',
        path: 'docs/fixes/SHOP-42.md',
        maxBytes: 1024 * 1024,
      },
    ]);
    expect(h.service.readArtifact(run.id, { step: 'fix', name: 'notes' })?.content).toBe('# notes');
    expect(stepOf(h, run.id, 'fix').status).toBe('completed');
  });

  it.each([
    [
      { ok: false as const, reason: 'missing' as const },
      '`notes` (docs/fixes/SHOP-42.md) is not in the commit `fix` ended at',
    ],
    [
      { ok: false as const, reason: 'not-a-file' as const },
      '`docs/fixes/SHOP-42.md` is not a regular file',
    ],
    [
      { ok: false as const, reason: 'too-large' as const },
      '`docs/fixes/SHOP-42.md` is larger than 1 MB',
    ],
    [
      { ok: true as const, text: 'x'.repeat(256 * 1024 + 1) },
      '`docs/fixes/SHOP-42.md` is larger than 256 KB, the most Consola hands a later step',
    ],
  ])(
    'a path artifact that is not there after its reminder fails the step: %o',
    async (answer, error) => {
      const h = await writing(POLL_WRITE);
      h.world.runCheckouts.showAnswers = [{ ok: false, reason: 'missing' }, answer];
      await check(h, 'poll-write', []);
      await check(h, 'poll-write', [{ key: 'SHOP-42' }]);
      const [run] = h.store.runs().filter((candidate) => candidate.automationId === 'poll-write');
      await h.world.endTurn(lastSession(h), { exitCode: 0 });
      await h.world.endTurn(lastSession(h), { exitCode: 0 });
      expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'failed', error });
      expect(stepOf(h, run.id, 'pr').status).toBe('not-run');
    },
  );

  it('a path artifact that is not a file fails at once, with no reminder', async () => {
    const h = await writing(POLL_WRITE);
    h.world.runCheckouts.showAnswers = [{ ok: false, reason: 'not-a-file' }];
    await check(h, 'poll-write', []);
    await check(h, 'poll-write', [{ key: 'SHOP-42' }]);
    const [run] = h.store.runs().filter((candidate) => candidate.automationId === 'poll-write');
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    expect(h.world.reminders).toEqual([]);
    expect(stepOf(h, run.id, 'fix').error).toBe('`docs/fixes/SHOP-42.md` is not a regular file');
  });

  it('Retry of a write step ends its leftovers, keeps its patch and starts from its before', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    // fix's turn fails: its changes are kept as a patch, nothing committed, the run's head still fix's before.
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(runOf(h, run.id).status).toBe('failed');
    const done = h.world.runCheckouts.calls.length;
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.runCheckouts.calls.slice(done, done + 3)).toEqual([
      { endStepProcesses: { dir: ownedDir(h, run.id), sessionId: 'session-1' } },
      {
        settle: expect.objectContaining({
          step: 'fix',
          before: 'b0',
          commit: null,
          keepOnly: true,
          attemptDir: h.folder.attemptDir(WORKSPACE_ID, run.id, 'fix', 1),
        }),
      },
      { reset: { dir: ownedDir(h, run.id), before: 'b0', branch: `fix/${run.id.slice(0, 8)}` } },
    ]);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ attempt: 2, status: 'running' });
    expect(h.world.launches).toHaveLength(2);
  });

  it('Retry of a write step that committed puts the checkout and its head back to its before', async () => {
    const h = await writing(POLL_WRITE);
    // It commits (c1), then its path artifact is missing twice: it failed after its commit.
    h.world.runCheckouts.showAnswers = [
      { ok: false, reason: 'missing' },
      { ok: false, reason: 'missing' },
    ];
    await check(h, 'poll-write', []);
    await check(h, 'poll-write', [{ key: 'SHOP-42' }]);
    const [run] = h.store.runs().filter((candidate) => candidate.automationId === 'poll-write');
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    expect(runOf(h, run.id)).toMatchObject({ status: 'failed', checkout: { head: 'c1' } });
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.runCheckouts.calls).toContainEqual({
      reset: { dir: ownedDir(h, run.id), before: 'b0', branch: 'fix/SHOP-42' },
    });
    expect(runOf(h, run.id).checkout!.head).toBe('b0');
    expect(stepOf(h, run.id, 'fix').checkout).toEqual({ before: 'b0' });
  });

  it('Retry is refused while what the step left still runs, and the run stays as it was', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    h.world.processes.end = { kind: 'strangers', processes: [{ pid: 77, command: 'vite' }] };
    const done = h.world.runCheckouts.calls.length;
    await expect(h.service.retry(run.id)).rejects.toThrow(
      "a process outside Consola's sessions is running in this run's checkout (vite, pid 77); end it, then retry",
    );
    expect(callNames(h, done)).toEqual(['endStepProcesses']);
    expect(runOf(h, run.id).status).toBe('failed');
    expect(stepOf(h, run.id, 'fix').attempt).toBe(1);
  });

  it('a write step interrupted by a quit is retried only once its leftovers are ended', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    expect(stepOf(h, run.id, 'fix').status).toBe('running');
    const again = await h.relaunch();
    await again.flush();
    expect(stepOf(again, run.id, 'fix')).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_WRITE,
    });
    again.world.processes.end = { kind: 'survivors', count: 2 };
    const done = again.world.runCheckouts.calls.length;
    await expect(again.service.retry(run.id)).rejects.toThrow(
      'a process the step started is still running in the checkout',
    );
    again.world.processes.end = { kind: 'clear' };
    await again.service.retry(run.id);
    await again.flush();
    expect(callNames(again, done)).toEqual([
      'endStepProcesses',
      'endStepProcesses',
      'settle',
      'reset',
      'settleBetween',
    ]);
    expect(stepOf(again, run.id, 'fix').attempt).toBe(2);
  });

  it('Retry of a command runs it in the checkout as it is: no reset, the git folder checked before it spawns', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    await stepCommands(h)[0].end({ result: { exitCode: 1 } });
    expect(stepOf(h, run.id, 'pr').status).toBe('failed');
    const done = h.world.runCheckouts.calls.length;
    const checked = h.world.runCheckouts.folderChecks.length;
    await h.service.retry(run.id);
    await h.flush();
    // No reset: only the boundary before it starts (Task 14).
    expect(callNames(h, done)).toEqual(['settleBetween']);
    expect(h.world.runCheckouts.folderChecks.slice(checked)).toEqual([ownedDir(h, run.id)]);
    expect(stepCommands(h)).toHaveLength(2);
    expect(stepCommands(h)[1].spec.env.CONSOLA_CHECKOUT_HEAD).toBe('c1');
    await stepCommands(h)[1].end();
    expect(callNames(h, done)).toEqual(['settleBetween', 'endStepProcesses', 'settle']);
  });

  it('a declared retry of a write step ends its leftovers, keeps its patch and resets before its next attempt', async () => {
    const yaml = WRITE_ENTRY.replace(
      '  prompt: Fix it.',
      '  prompt: Fix it.\n        on_failure: { retry: 1 }',
    );
    expect(yaml).toContain('on_failure: { retry: 1 }');
    const h = await writing(
      yaml,
      {},
      {
        'agents/fixer.md': '---\ntools: edit\nenvironment: sandboxed\n---\nFix it.\n',
        'environments/sandboxed.yaml': 'isolation: sandbox\n',
      },
    );
    expect(problemOf(h, 'write')).toBeUndefined();
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(runOf(h, run.id).status).toBe('waiting');
    const done = h.world.runCheckouts.calls.length;
    h.advance(60_000);
    await h.tick();
    expect(callNames(h, done)).toEqual(['endStepProcesses', 'settle', 'reset', 'settleBetween']);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ attempt: 2, status: 'running' });
    expect(h.world.launches).toHaveLength(2);
  });

  it('a declared retry of a write step that committed before it failed puts the head back to its before', async () => {
    const yaml = POLL_WRITE.replace(
      '  artifacts: [{ name: notes',
      '  on_failure: { retry: 1 }\n        artifacts: [{ name: notes',
    );
    expect(yaml).toContain('on_failure: { retry: 1 }');
    const h = await writing(
      yaml,
      {},
      {
        'agents/fixer.md': '---\ntools: edit\nenvironment: sandboxed\n---\nFix it.\n',
        'environments/sandboxed.yaml': 'isolation: sandbox\n',
      },
    );
    await check(h, 'poll-write', []);
    await check(h, 'poll-write', [{ key: 'SHOP-42' }]);
    const [run] = h.store.runs().filter((candidate) => candidate.automationId === 'poll-write');
    // Committed (c1), then its path artifact is missing after its reminder.
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    expect(runOf(h, run.id)).toMatchObject({ status: 'waiting', checkout: { head: 'c1' } });
    h.advance(60_000);
    await h.tick();
    expect(h.world.runCheckouts.calls).toContainEqual({
      reset: { dir: ownedDir(h, run.id), before: 'b0', branch: 'fix/SHOP-42' },
    });
    expect(runOf(h, run.id).checkout!.head).toBe('b0');
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ attempt: 2, checkout: { before: 'b0' } });
  });

  it('a quit while a step is being checked records nothing more from the service that quit', async () => {
    const h = await writing(WRITE_ENTRY);
    let release!: () => void;
    h.world.processes.gate = new Promise<void>((resolve) => (release = resolve));
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(callNames(h)).toEqual(['make', 'settleBetween', 'endStepProcesses']);
    const again = await h.relaunch();
    await again.flush();
    h.world.processes.gate = undefined;
    release();
    await again.flush();
    expect(callNames(again)).toEqual(['make', 'settleBetween', 'endStepProcesses']);
    expect(stepOf(again, run.id, 'fix')).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_WRITE,
    });
  });

  it('a declared retry whose leftovers still run fails the run instead, with their words', async () => {
    const yaml = WRITE_ENTRY.replace(
      '  prompt: Fix it.',
      '  prompt: Fix it.\n        on_failure: { retry: 1 }',
    );
    const h = await writing(
      yaml,
      {},
      {
        'agents/fixer.md': '---\ntools: edit\nenvironment: sandboxed\n---\nFix it.\n',
        'environments/sandboxed.yaml': 'isolation: sandbox\n',
      },
    );
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    h.world.processes.end = { kind: 'survivors', count: 1 };
    h.advance(60_000);
    await h.tick();
    expect(runOf(h, run.id)).toMatchObject({
      status: 'failed',
      error: 'a process the step started is still running in the checkout',
    });
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'failed', attempt: 1 });
    expect(h.world.launches).toHaveLength(1);
  });

  it("the entry's declared retry of a run that owns its checkout keeps its record and makes nothing again", async () => {
    const yaml = EVENT_OWNED.replace(
      '    mode: auto\n',
      '    mode: auto\n    on_failure: { retry: 1 }\n',
    ).replace('- id: check\n        run: "true"', '- id: look\n        prompt: Look at it.');
    expect(yaml).toContain('prompt: Look at it.');
    const h = await writing(yaml);
    await h.poll([]);
    await h.poll([inboxItem({ repo: REPO, number: 51 })]);
    const [run] = h.store.runs();
    const made = runOf(h, run.id).checkout;
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(runOf(h, run.id).status).toBe('waiting');
    h.advance(60_000);
    await h.tick();
    expect(runOf(h, run.id)).toMatchObject({ status: 'running', retried: 1 });
    expect(runOf(h, run.id).checkout).toEqual({ ...made, head: made!.head });
    expect(makes(h)).toHaveLength(1);
    expect(h.world.launches).toHaveLength(2);
  });
});

describe("a reminder and a resume start a step's CLI in its run's checkout: the git folder is checked first (Task 13 review)", () => {
  /** `fix` writes and must set `done`, then `pr` a command. */
  const OUTPUT_WRITE = file(
    `  - name: write\n    on: manual\n    mode: auto\n${owned('fix/{{run.id}}')}${steps('- id: fix\n  agent: fixer\n  prompt: Fix it.\n  outputs: { done: boolean }', '- id: pr\n  run: "true"')}`,
  );
  /** `look` a read-only agent in the run's checkout, then `pr` a command. */
  const READ_ENTRY = file(
    `  - name: read\n    on: manual\n    mode: auto\n${owned('look/{{run.id}}')}${steps('- id: look\n  agent: reader\n  prompt: Look.', '- id: pr\n  run: "true"')}`,
  );
  const READER = { ...WRITER, 'agents/reader.md': 'Read it.\n' };
  const CHANGED =
    "the git folder of this run's checkout changed (`config` changed), so Consola will not start anything in it";

  it('a step that ended without its outputs is reminded once the git folder is as made', async () => {
    const h = await writing(OUTPUT_WRITE);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(h.world.reminders).toHaveLength(1);
    expect(h.world.runCheckouts.folderChecks).toEqual([ownedDir(h, run.id), ownedDir(h, run.id)]);
  });

  it('a changed git folder fails the step instead of reminding it, and keeps what it left uncommitted', async () => {
    const h = await writing(OUTPUT_WRITE);
    const run = await runNow(h, 'write');
    h.world.folderProblem = () => '`config` changed';
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(h.world.reminders).toEqual([]);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'failed', error: CHANGED });
    expect(stepOf(h, run.id, 'pr').status).toBe('not-run');
    // Its processes ended first, then its patch kept: nothing committed.
    expect(callNames(h)).toEqual(['make', 'settleBetween', 'endStepProcesses', 'settle']);
    expect(settles(h)[0]).toMatchObject({ commit: null, keepOnly: true });
  });

  it('a path artifact missing at its commit is reminded only while the git folder is as made', async () => {
    const h = await writing(POLL_WRITE);
    h.world.runCheckouts.showAnswers = [{ ok: false, reason: 'missing' }];
    await check(h, 'poll-write', []);
    await check(h, 'poll-write', [{ key: 'SHOP-42' }]);
    const [run] = h.store.runs().filter((candidate) => candidate.automationId === 'poll-write');
    h.world.folderProblem = () => '`config` changed';
    await h.world.endTurn(lastSession(h), { exitCode: 0 });
    expect(h.world.reminders).toEqual([]);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'failed', error: CHANGED });
  });

  it('a read-only step a quit cut off resumes in its session once the git folder is as made', async () => {
    const h = await writing(READ_ENTRY, {}, READER);
    const run = await runNow(h, 'read');
    expect(stepOf(h, run.id, 'look').status).toBe('running');
    const again = await h.relaunch();
    await again.flush();
    expect(again.world.resumes).toEqual([{ sessionId: 'session-1', prompt: expect.any(String) }]);
    expect(again.world.runCheckouts.folderChecks).toEqual([
      ownedDir(h, run.id),
      ownedDir(h, run.id),
    ]);
  });

  it('a changed git folder fails it instead of resuming it, and starts nothing there', async () => {
    const h = await writing(READ_ENTRY, {}, READER);
    const run = await runNow(h, 'read');
    h.world.folderProblem = () => '`config` changed';
    const again = await h.relaunch();
    await again.flush();
    expect(again.world.resumes).toEqual([]);
    expect(again.world.launches).toHaveLength(1);
    expect(stepOf(again, run.id, 'look')).toMatchObject({ status: 'failed', error: CHANGED });
    expect(stepOf(again, run.id, 'pr').status).toBe('not-run');
    expect(stepCommands(again)).toEqual([]);
  });
});

describe("a person's session in a run's checkout holds the run, and what it leaves is committed apart (Task 14)", () => {
  const HOLDER = { sessionId: 'sfix', name: 'fix' };
  const betweens = (h: StepsHarness) =>
    h.world.runCheckouts.calls.flatMap((call) =>
      'settleBetween' in call ? [call.settleBetween] : [],
    );
  const listed = (h: StepsHarness, id: string) =>
    h.service.snapshot(WORKSPACE_ID).runs.find((run) => run.id === id)!;
  /** `fix` writes, a person answers `ok`, then `pr` a command. */
  const GATED_WRITE = file(
    `  - name: write\n    on: manual\n    mode: auto\n${owned('fix/{{run.id}}')}${steps('- id: fix\n  agent: fixer\n  prompt: Fix it.', '- id: ok\n  gate: { ask: Push it? }', '- id: pr\n  run: "true"')}`,
  );
  /** A pull request's event: `fix` writes in the run's own checkout. */
  const PR_WRITE = file(
    `  - name: pr-write\n    on: { github: pull_request.review_requested }\n    mode: auto\n${owned('fix/pr-{{item.number}}')}${steps('- id: fix\n  agent: fixer\n  prompt: Fix it.', '- id: pr\n  run: "true"')}`,
  );

  /** `write` run now, `fix`'s turn ended while `HOLDER` is open in the checkout. */
  async function heldAfterFix(yaml = WRITE_ENTRY) {
    const h = await writing(yaml);
    const run = await runNow(h, 'write');
    h.world.holders.set(ownedDir(h, run.id), HOLDER);
    await h.world.endTurn('session-1', { exitCode: 0 });
    return { h, run };
  }

  it('a session open in the checkout makes the run wait before its next step, saying which, with no status change', async () => {
    const { h, run } = await heldAfterFix();
    expect(runOf(h, run.id)).toMatchObject({ status: 'running', waitingFor: { session: 'sfix' } });
    expect(runOf(h, run.id).checkout!.lastHolder).toBe('sfix');
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'completed',
      checkout: { after: 'c1' },
    });
    expect(stepOf(h, run.id, 'pr').status).toBe('pending');
    expect(stepCommands(h)).toEqual([]);
    // Activity names the session.
    expect(listed(h, run.id).waitingFor).toEqual({ session: 'fix' });
  });

  it('nothing is settled between steps while a session holds the checkout, at the boundary or at a tick', async () => {
    const { h, run } = await heldAfterFix();
    // One before `fix` started, in a checkout nobody held; none since.
    expect(betweens(h)).toHaveLength(1);
    await h.tick();
    await h.tick();
    expect(betweens(h)).toHaveLength(1);
    expect(runOf(h, run.id).waitingFor).toEqual({ session: 'sfix' });
    expect(stepCommands(h)).toEqual([]);
  });

  it('once it closes, what it left is committed apart and the run goes on', async () => {
    const { h, run } = await heldAfterFix();
    h.world.holders.clear();
    h.world.runCheckouts.betweenAnswers = [
      { ok: true, after: 'p1', files: 1, flagged: ['.github/x'] },
    ];
    await h.tick();
    expect(betweens(h).at(-1)).toEqual({
      dir: ownedDir(h, run.id),
      branch: `fix/${run.id.slice(0, 8)}`,
      base: 'b0',
      before: 'c1',
      message: 'changes by fix during write',
      session: 'fix',
    });
    expect(runOf(h, run.id).checkout).toMatchObject({
      head: 'p1',
      byPerson: [
        {
          session: 'sfix',
          before: 'c1',
          after: 'p1',
          files: 1,
          flagged: ['.github/x'],
          at: h.now().toISOString(),
        },
      ],
    });
    expect(runOf(h, run.id).checkout!.lastHolder).toBeUndefined();
    expect(runOf(h, run.id).waitingFor).toBeUndefined();
    expect(stepOf(h, run.id, 'pr').status).toBe('running');
    expect(stepCommands(h)[0].spec.env.CONSOLA_CHECKOUT_HEAD).toBe('p1');
  });

  it('a session that left nothing lets the run go on with no commit and no entry', async () => {
    const { h, run } = await heldAfterFix();
    h.world.holders.clear();
    await h.tick();
    expect(runOf(h, run.id).checkout).toMatchObject({ head: 'c1' });
    expect(runOf(h, run.id).checkout!.byPerson).toBeUndefined();
    expect(runOf(h, run.id).checkout!.lastHolder).toBeUndefined();
    expect(runOf(h, run.id).waitingFor).toBeUndefined();
    expect(stepOf(h, run.id, 'pr').status).toBe('running');
  });

  it.each([
    ['a moved HEAD', '`fix`, opened by you, moved `HEAD` off fix/x'],
    ['a process', "`fix`, opened by you, left a process running in this run's checkout"],
  ])(
    '%s it left fails the run in its words, the next step not-run; Retry starts there',
    async (_, error) => {
      const { h, run } = await heldAfterFix();
      h.world.holders.clear();
      h.world.runCheckouts.betweenAnswers = [{ ok: false, error }];
      await h.tick();
      expect(runOf(h, run.id)).toMatchObject({ status: 'failed', error });
      expect(runOf(h, run.id).waitingFor).toBeUndefined();
      expect(stepOf(h, run.id, 'fix').status).toBe('completed');
      expect(stepOf(h, run.id, 'pr').status).toBe('not-run');
      expect(stepCommands(h)).toEqual([]);
      await h.service.retry(run.id, 'pr');
      await h.flush();
      expect(stepCommands(h)).toHaveLength(1);
    },
  );

  it('changes left by a session never seen are committed as a session', async () => {
    const h = await writing(WRITE_ENTRY);
    // Nothing before `fix`; after it, a session nobody saw left three files.
    h.world.runCheckouts.betweenAnswers = [null, { ok: true, after: 'p1', files: 3, flagged: [] }];
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(betweens(h)).toHaveLength(2);
    expect(betweens(h)[1]).toMatchObject({
      before: 'c1',
      message: 'changes by a session during write',
    });
    expect(betweens(h)[1]).not.toHaveProperty('session');
    expect(runOf(h, run.id).checkout!.byPerson).toEqual([
      { before: 'c1', after: 'p1', files: 3, flagged: [], at: h.now().toISOString() },
    ]);
    expect(stepOf(h, run.id, 'pr').status).toBe('running');
  });

  it("a session open while a step runs is recorded at a tick; the step's own session is not", async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    // The step's own CLI runs in the checkout: never its holder.
    h.world.holders.set(ownedDir(h, run.id), { sessionId: 'session-1', name: 'write · fix' });
    await h.tick();
    expect(runOf(h, run.id).checkout!.lastHolder).toBeUndefined();
    h.world.holders.set(ownedDir(h, run.id), HOLDER);
    await h.tick();
    expect(runOf(h, run.id).checkout!.lastHolder).toBe('sfix');
    expect(runOf(h, run.id).waitingFor).toBeUndefined();
  });

  it('a run parked at a gate records who holds its checkout, and waits for them after the answer', async () => {
    const h = await writing(GATED_WRITE);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(runOf(h, run.id).status).toBe('waiting');
    h.world.holders.set(ownedDir(h, run.id), HOLDER);
    await h.tick();
    expect(runOf(h, run.id).checkout!.lastHolder).toBe('sfix');
    h.service.answerGate(run.id, 'ok', 'approve');
    await h.flush();
    expect(runOf(h, run.id)).toMatchObject({ status: 'running', waitingFor: { session: 'sfix' } });
    expect(stepOf(h, run.id, 'pr').status).toBe('pending');
    h.world.holders.clear();
    await h.tick();
    expect(stepOf(h, run.id, 'pr').status).toBe('running');
  });

  it('a declared retry of a write step waits while a session holds the checkout, and resets once it closes', async () => {
    const yaml = WRITE_ENTRY.replace(
      '  prompt: Fix it.',
      '  prompt: Fix it.\n        on_failure: { retry: 1 }',
    );
    expect(yaml).toContain('on_failure: { retry: 1 }');
    const h = await writing(
      yaml,
      {},
      {
        'agents/fixer.md': '---\ntools: edit\nenvironment: sandboxed\n---\nFix it.\n',
        'environments/sandboxed.yaml': 'isolation: sandbox\n',
      },
    );
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(runOf(h, run.id).status).toBe('waiting');
    h.world.holders.set(ownedDir(h, run.id), HOLDER);
    const done = h.world.runCheckouts.calls.length;
    h.advance(60_000);
    await h.tick();
    expect(callNames(h, done)).toEqual([]);
    expect(runOf(h, run.id)).toMatchObject({ status: 'waiting', waitingFor: { session: 'sfix' } });
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'waiting', attempt: 1 });
    h.world.holders.clear();
    await h.tick();
    expect(callNames(h, done)).toEqual(['endStepProcesses', 'settle', 'reset', 'settleBetween']);
    expect(runOf(h, run.id).waitingFor).toBeUndefined();
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'running', attempt: 2 });
  });

  it.each([
    ['a manual run', WRITE_ENTRY],
    ['a pull request', PR_WRITE],
  ])(
    "a person's Retry is refused while a session is open, on %s, and nothing is reset",
    async (_, yaml) => {
      const h = await writing(yaml);
      let run: { id: string };
      if (yaml === PR_WRITE) {
        await h.poll([]);
        await h.poll([inboxItem({ repo: REPO, number: 51 })]);
        [run] = h.store.runs();
      } else run = await runNow(h, 'write');
      await h.world.endTurn('session-1', { exitCode: 1 });
      expect(runOf(h, run.id).status).toBe('failed');
      h.world.holders.set(ownedDir(h, run.id), HOLDER);
      const done = h.world.runCheckouts.calls.length;
      await expect(h.service.retry(run.id)).rejects.toThrow(
        "`fix` is open in this run's checkout; close it, then retry",
      );
      expect(callNames(h, done)).toEqual([]);
      expect(runOf(h, run.id).status).toBe('failed');
      h.world.holders.clear();
      await expect(h.service.retry(run.id)).resolves.toMatchObject({ status: 'running' });
    },
  );

  it("a loop's round is one boundary with its first step, checked once, and each later round's again", async () => {
    const LOOP_WRITE = file(
      `  - name: write\n    on: manual\n    mode: auto\n${owned('fix/{{run.id}}')}${steps('- id: polish\n  repeat: { max: 2, until: steps.fix.done }\n  steps:\n    - id: fix\n      agent: fixer\n      prompt: Fix it.\n      outputs: { done: boolean }')}`,
    );
    const h = await writing(LOOP_WRITE);
    const run = await runNow(h, 'write');
    expect(callNames(h)).toEqual(['make', 'settleBetween']);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'running', round: 1 });
    h.world.setOutputs('session-1', { done: false });
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(callNames(h, 2)).toEqual(['endStepProcesses', 'settle', 'settleBetween']);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ status: 'running', round: 2 });
  });

  it('a boundary still settling is not asked again: one commit, one start, however often the run is picked up', async () => {
    const { h, run } = await heldAfterFix();
    let release!: () => void;
    h.world.runCheckouts.betweenGate = new Promise<void>((resolve) => (release = resolve));
    h.world.holders.clear();
    h.world.runCheckouts.betweenAnswers = [{ ok: true, after: 'p1', files: 1, flagged: [] }];
    await h.tick();
    await h.tick();
    expect(betweens(h)).toHaveLength(2);
    h.world.runCheckouts.betweenGate = undefined;
    release();
    await h.flush();
    expect(betweens(h)).toHaveLength(2);
    expect(runOf(h, run.id).checkout!.byPerson).toHaveLength(1);
    expect(stepCommands(h)).toHaveLength(1);
  });

  it('a session opened while the boundary settled holds the run before its next step starts', async () => {
    const { h, run } = await heldAfterFix();
    let release!: () => void;
    h.world.runCheckouts.betweenGate = new Promise<void>((resolve) => (release = resolve));
    h.world.holders.clear();
    await h.tick();
    expect(betweens(h)).toHaveLength(2);
    h.world.holders.set(ownedDir(h, run.id), { sessionId: 'sreview', name: 'review' });
    h.world.runCheckouts.betweenGate = undefined;
    release();
    await h.flush();
    expect(runOf(h, run.id)).toMatchObject({
      status: 'running',
      waitingFor: { session: 'sreview' },
    });
    expect(stepCommands(h)).toEqual([]);
    h.world.holders.clear();
    await h.tick();
    expect(betweens(h)).toHaveLength(3);
    expect(betweens(h)[2]).toMatchObject({ message: 'changes by review during write' });
    expect(stepCommands(h)).toHaveLength(1);
  });

  it('a full-tools continuation is refused while the run is open and allowed after', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    expect(h.service.continuationRefusal(run.id, 'fix')).toBe(
      'Continue with full tools after the run ends',
    );
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(runOf(h, run.id).status).toBe('running');
    expect(h.service.continuationRefusal(run.id, 'fix')).toBe(
      'Continue with full tools after the run ends',
    );
    await stepCommands(h)[0].end({ result: { exitCode: 0 } });
    expect(runOf(h, run.id).status).toBe('completed');
    expect(h.service.continuationRefusal(run.id, 'fix')).toBeNull();
  });
});

describe("what later steps read of a run's checkout (Task 15)", () => {
  const MATERIAL_BYTES = 256 * 1024;
  const DIFF = 'diff --git a/x b/x\n+fixed\n';
  /** `fix` writes, `review` (read-only) reads the branch's changes, then `pr` a command. */
  const REVIEW_ENTRY = file(
    `  - name: write\n    on: manual\n    mode: auto\n${owned('fix/{{run.id}}')}${steps('- id: fix\n  agent: fixer\n  prompt: Fix it.', '- id: review\n  agent: reader\n  prompt: Review it.\n  reads: [checkout.changes]', '- id: pr\n  run: "true"')}`,
  );
  /** `fix` writes, a gate shows the branch's changes, then `pr` a command. */
  const GATED_SHOW = file(
    `  - name: write\n    on: manual\n    mode: auto\n${owned('fix/{{run.id}}')}${steps('- id: fix\n  agent: fixer\n  prompt: Fix it.', '- id: ok\n  gate: { ask: Push it?, show: [checkout.changes] }', '- id: pr\n  run: "true"')}`,
  );
  const READER = { ...WRITER, 'agents/reader.md': 'Read it.\n' };
  const reads = (h: StepsHarness) => h.world.runCheckouts.materialReads;
  const fileIn = (h: StepsHarness, runId: string, step: string, name: string) =>
    path.join(h.folder.attemptDir(WORKSPACE_ID, runId, step, 1), name);

  it("an agent step gets the repository's CLAUDE.md at base, and nothing when there is none", async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.runCheckouts.claudeMd = '# rules\n';
    const run = await runNow(h, 'write');
    expect(reads(h)).toEqual([
      {
        showAt: {
          dir: ownedDir(h, run.id),
          commit: 'b0',
          path: 'CLAUDE.md',
          maxBytes: 1024 * 1024,
        },
      },
    ]);
    expect(fs.readFileSync(fileIn(h, run.id, 'fix', 'CLAUDE.md'), 'utf8')).toBe('# rules\n');
    // A write agent's session says what it is (Call 17): `fixer` writes on `sandbox`, with no network.
    expect(h.world.launches[0].prompt).toContain(
      'This session writes files and runs commands: it can change the files in this checkout and run commands in a shell that can write only this checkout and reach no network',
    );
    expect(h.world.launches[0].prompt).toContain(
      '  - checkout.claude-md (CLAUDE.md at b0, the commit this run cut from, 8 B)',
    );
    // A step that does not declare `checkout.changes` is handed none.
    expect(h.world.launches[0].prompt).not.toContain('checkout.changes');
    expect(fs.existsSync(fileIn(h, run.id, 'fix', 'checkout-changes.patch'))).toBe(false);

    const none = await writing(WRITE_ENTRY);
    const other = await runNow(none, 'write');
    expect(none.world.launches[0].prompt).not.toContain('checkout.claude-md');
    expect(fs.existsSync(fileIn(none, other.id, 'fix', 'CLAUDE.md'))).toBe(false);
  });

  it('a CLAUDE.md over 256 KB is cut there, saying how much more there is', async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.runCheckouts.claudeMd = 'x'.repeat(MATERIAL_BYTES + 40 * 1024);
    const run = await runNow(h, 'write');
    const attached = fs.readFileSync(fileIn(h, run.id, 'fix', 'CLAUDE.md'), 'utf8');
    expect(attached).toBe(`${'x'.repeat(MATERIAL_BYTES)}\n[cut here: the rest is 40 KB more]`);
  });

  it('a read-only agent step in a run-owned checkout reads the changes it declares, at the head it starts from', async () => {
    const h = await writing(REVIEW_ENTRY, {}, READER);
    h.world.runCheckouts.changesText = DIFF;
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(stepOf(h, run.id, 'review').status).toBe('running');
    expect(reads(h)).toContainEqual({
      changes: { dir: ownedDir(h, run.id), base: 'b0', head: 'c1', maxBytes: MATERIAL_BYTES },
    });
    expect(fs.readFileSync(fileIn(h, run.id, 'review', 'checkout-changes.patch'), 'utf8')).toBe(
      DIFF,
    );
    expect(h.world.launches[1].prompt).toContain(
      `  - checkout.changes (changes on fix/${run.id.slice(0, 8)} since b0, 26 B)`,
    );
  });

  it('a diff over 256 KB is cut there, saying how much more there is', async () => {
    const h = await writing(REVIEW_ENTRY, {}, READER);
    h.world.runCheckouts.changesText = 'y'.repeat(MATERIAL_BYTES + 10 * 1024);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(fs.readFileSync(fileIn(h, run.id, 'review', 'checkout-changes.patch'), 'utf8')).toBe(
      `${'y'.repeat(MATERIAL_BYTES)}\n[cut here: the rest is 10 KB more]`,
    );
  });

  it('a command gets the changes from base to the head it starts at as a file', async () => {
    const h = await writing(WRITE_ENTRY);
    h.world.runCheckouts.changesText = DIFF;
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(reads(h)).toContainEqual({
      changes: { dir: ownedDir(h, run.id), base: 'b0', head: 'c1', maxBytes: MATERIAL_BYTES },
    });
    const env = stepCommands(h)[0].spec.env;
    expect(env.CONSOLA_CHANGES_FILE).toBe(fileIn(h, run.id, 'pr', 'checkout-changes.patch'));
    expect(fs.readFileSync(env.CONSOLA_CHANGES_FILE!, 'utf8')).toBe(DIFF);
    expect(env).toMatchObject({ CONSOLA_BRANCH: `fix/${run.id.slice(0, 8)}`, CONSOLA_BASE: 'b0' });
  });

  it('a gate shows the branch diff at the head it parked on', async () => {
    const h = await writing(GATED_SHOW);
    h.world.runCheckouts.changesText = DIFF;
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(runOf(h, run.id).status).toBe('waiting');
    expect(reads(h)).toContainEqual({
      changes: { dir: ownedDir(h, run.id), base: 'b0', head: 'c1', maxBytes: MATERIAL_BYTES },
    });
    expect(h.service.gateOf(run.id, 'ok')!.material).toEqual([
      {
        step: 'checkout',
        name: 'changes',
        label: `changes on fix/${run.id.slice(0, 8)} since b0`,
        text: DIFF,
        truncated: false,
      },
    ]);
  });

  it('a run that ends while its checkout is read starts nothing there', async () => {
    const h = await writing(REVIEW_ENTRY, {}, READER);
    const run = await runNow(h, 'write');
    let release!: () => void;
    h.world.runCheckouts.materialGate = new Promise<void>((resolve) => (release = resolve));
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(stepOf(h, run.id, 'review').status).toBe('queued');
    h.service.stop(run.id);
    await h.flush();
    h.world.runCheckouts.materialGate = undefined;
    release();
    await h.flush();
    expect(h.world.launches).toHaveLength(1);
    expect(runOf(h, run.id).status).toBe('failed');
  });

  it('a checkout that cannot be read fails the step before it starts, saying so', async () => {
    const h = await writing(REVIEW_ENTRY, {}, READER);
    const run = await runNow(h, 'write');
    h.world.runCheckouts.changesText = DIFF;
    const port = h.world.runCheckouts;
    port.materialReads.push = () => {
      throw new Error('git diff: bad object c1');
    };
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(h.world.launches).toHaveLength(1);
    expect(stepOf(h, run.id, 'review')).toMatchObject({
      status: 'failed',
      error: "Consola couldn't read this run's checkout for review: git diff: bad object c1",
    });
  });
});

describe('a host says whether its launch holds a write agent (Call 2, Task 13)', () => {
  const LOOP = file(
    `  - name: loop\n    on: manual\n    mode: auto\n${owned('fix/{{run.id}}')}${steps('- id: polish\n  repeat: { max: 2, until: steps.fix.done }\n  steps:\n    - id: fix\n      agent: fixer\n      prompt: Fix it.\n      outputs: { done: boolean }')}`,
  );

  it.each(['edit', 'write'])(
    'refuses an agent with tools: %s on a host with the port but no writeAgents, in a loop too',
    async (tools) => {
      const h = await stepsHarness({
        yaml: LOOP,
        files: {
          'agents/fixer.md': `---\ntools: ${tools}\nenvironment: sandboxed\n---\nFix it.\n`,
          'environments/sandboxed.yaml': 'isolation: sandbox\n',
        },
        runCheckouts: true,
        writeAgents: false,
      });
      expect(problemOf(h, 'loop')).toBe(
        `This runner can't hold an agent that writes to its environment, so \`tools: ${tools}\` can't run here.`,
      );
    },
  );

  it('says a checkout the run owns first, on a host with neither', async () => {
    const h = await stepsHarness({ yaml: WRITE_ENTRY, files: WRITER });
    expect(problemOf(h, 'write')).toBe(NO_RUN_CHECKOUTS);
  });

  it('runs a write agent once the host holds one, and a read-only agent on either host', async () => {
    const both = await stepsHarness({ yaml: WRITE_ENTRY, files: WRITER, runCheckouts: true });
    expect(problemOf(both, 'write')).toBeUndefined();
    const readOnly = await stepsHarness({
      yaml: WRITE_ENTRY,
      files: { 'agents/fixer.md': '---\ntools: read-only\n---\nLook.\n' },
      runCheckouts: true,
      writeAgents: false,
    });
    expect(problemOf(readOnly, 'write')).toBeUndefined();
  });
});

describe('what the version, a dry run and a retry make of a write agent (Tasks 6 and 9, owed to Task 13)', () => {
  it("an environment edit moves the entry's resolved version, equal to the file's (E10)", async () => {
    const h = await writing(WRITE_ENTRY);
    // The version a run records is the one its entry resolved to.
    const before = versionOf(h, 'write');
    const first = await runNow(h, 'write');
    expect(first.actionVersion).toBe(before);
    await h.world.endTurn('session-1', { exitCode: 1 });
    await h.writeFile(
      'environments/sandboxed.yaml',
      'isolation: sandbox\nnetwork: [registry.npmjs.org]\n',
    );
    const after = versionOf(h, 'write');
    expect(after).not.toBe(before);
    // A changed entry asks again, at its new version.
    const second = await runNow(h, 'write');
    expect(second).toMatchObject({ status: 'needs-approval', actionVersion: after });
  });

  it('a dry run reports a write step it does not run, and runs the rest', async () => {
    const yaml = WRITE_ENTRY.replace('mode: auto', 'mode: notify').replace(
      '- id: fix\n',
      '- id: look\n        prompt: Look.\n      - id: fix\n',
    );
    expect(yaml).toContain('- id: look');
    const h = await writing(yaml);
    const run = await runNow(h, 'write');
    expect(runOf(h, run.id).dryRun).toBe(true);
    await h.world.endTurn('session-1', { exitCode: 0 });
    expect(stepOf(h, run.id, 'fix')).toMatchObject({
      status: 'reported',
      note: 'Would have run fixer in sandboxed',
    });
    expect(h.world.launches).toHaveLength(1);
  });

  it('a notify entry whose only agent writes starts nothing in a dry run, so it does not ask first', async () => {
    const onlyWrites = await stepsHarness({
      yaml: WRITE_ENTRY.replace('mode: auto', 'mode: notify'),
      files: WRITER,
      runCheckouts: true,
    });
    expect(onlyWrites.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
    const alsoReads = await stepsHarness({
      yaml: WRITE_ENTRY.replace('mode: auto', 'mode: notify').replace(
        '- id: fix\n',
        '- id: look\n        prompt: Look.\n      - id: fix\n',
      ),
      files: WRITER,
      runCheckouts: true,
    });
    expect(alsoReads.service.list(WORKSPACE_ID)[0].asksFirst).toBe(true);
  });

  it('a write agent on host never retries by itself; on sandbox it waits out its retry', async () => {
    const yaml = WRITE_ENTRY.replace(
      '  prompt: Fix it.',
      '  prompt: Fix it.\n        on_failure: { retry: 1 }',
    );
    const sandboxed = await writing(yaml);
    const kept = await runNow(sandboxed, 'write');
    await sandboxed.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(runOf(sandboxed, kept.id).status).toBe('waiting');

    // The format refuses a retry on `host`: the run's own definition is written as if a hand-built entry said so.
    const host = await writing(yaml);
    const run = await runNow(host, 'write');
    const definition = host.folder.readDefinition(WORKSPACE_ID, run.id)!;
    const fix = definition.agents!.fix;
    host.folder.writeDefinition(WORKSPACE_ID, run.id, {
      ...definition,
      agents: {
        ...definition.agents,
        fix: { ...fix, environment: { ...fix.environment!, isolation: 'host' } },
      },
    });
    await host.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(runOf(host, run.id)).toMatchObject({ status: 'failed' });
    expect(stepOf(host, run.id, 'fix').status).toBe('failed');
  });
});

describe('a write step launches held to its environment (Task 18)', () => {
  it('the launch carries the agent’s policy, its environment, the checkout and what is left of the budget', async () => {
    const yaml = WRITE_ENTRY.replace(
      '    mode: auto\n',
      '    mode: auto\n    budget: { usd: 5 }\n',
    );
    const h = await writing(
      yaml,
      {},
      {
        ...WRITER,
        'environments/sandboxed.yaml':
          'isolation: sandbox\nnetwork: [registry.npmjs.org]\nenv: [CI]\n',
      },
    );
    const run = await runNow(h, 'write');
    const step = h.world.launches[0].step!;
    expect(step).toMatchObject({
      checkout: 'run-owned',
      checkoutPath: ownedDir(h, run.id),
      maxBudgetUsd: 5,
      agent: {
        tools: 'write',
        environment: {
          name: 'sandboxed',
          isolation: 'sandbox',
          network: ['registry.npmjs.org'],
          env: ['CI'],
        },
      },
    });
    expect(step.cwd).toBe(step.checkoutPath);
  });

  it('a write step records its environment, the CLI version it ran under and what was passed', async () => {
    const h = await writing(
      WRITE_ENTRY,
      {},
      {
        ...WRITER,
        'environments/sandboxed.yaml': 'isolation: sandbox\nenv: [CI]\n',
      },
    );
    h.world.onLaunch = (_request, session) =>
      Object.assign(session, {
        environment: { cliVersion: '2.1.330', passed: ['CI'], missing: [] },
      });
    const run = await runNow(h, 'write');
    expect(stepOf(h, run.id, 'fix').environment).toEqual({
      name: 'sandboxed',
      isolation: 'sandbox',
      cliVersion: '2.1.330',
      passed: ['CI'],
      missing: [],
    });
  });

  it('a read-only step records no environment, and its launch carries no write fields', async () => {
    const h = await writing(
      WRITE_ENTRY,
      {},
      {
        ...WRITER,
        'agents/fixer.md': '---\ntools: read-only\n---\nLook.\n',
      },
    );
    const run = await runNow(h, 'write');
    const step = h.world.launches[0].step!;
    expect(step.agent).not.toHaveProperty('tools');
    expect(step.agent).not.toHaveProperty('environment');
    expect(step).not.toHaveProperty('maxBudgetUsd');
    expect(stepOf(h, run.id, 'fix')).not.toHaveProperty('environment');
    // A read-only step in a run's own checkout still names it: the host compiles its servers for it.
    expect(step.checkoutPath).toBe(ownedDir(h, run.id));
  });
});

describe("a run's own checkout that cleanup removed (Task 19)", () => {
  async function failedRun() {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 1, lastLine: 'Rate limited.' });
    expect(runOf(h, run.id).status).toBe('failed');
    return { h, run };
  }

  it('a Retry rebuilds the folder first, at what was recorded, never making it anew (Review Focus 5)', async () => {
    const { h, run } = await failedRun();
    const dir = ownedDir(h, run.id);
    h.world.goneFolders.add(dir);
    const done = h.world.runCheckouts.calls.length;
    await h.service.retry(run.id);
    await h.flush();
    const after = h.world.runCheckouts.calls.slice(done);
    expect(after[0]).toEqual({ restore: dir });
    expect(after.some((call) => 'make' in call)).toBe(false);
    expect(after.some((call) => 'reset' in call)).toBe(true);
    expect(stepOf(h, run.id, 'fix')).toMatchObject({ attempt: 2, status: 'running' });
  });

  it('a rebuild that fails refuses the Retry in words, and nothing is reset or started', async () => {
    const { h, run } = await failedRun();
    h.world.goneFolders.add(ownedDir(h, run.id));
    h.world.runCheckouts.restoreFails = new Error(
      'the commit it was on (3f2a91c) is no longer in the clone.',
    );
    const done = h.world.runCheckouts.calls.length;
    await expect(h.service.retry(run.id)).rejects.toThrow(
      "Couldn't rebuild this run's checkout of sprocket/catalog-portal: the commit it was on (3f2a91c) is no longer in the clone. Nothing was retried.",
    );
    expect(h.world.runCheckouts.calls.slice(done)).toEqual([{ restore: ownedDir(h, run.id) }]);
    expect(h.world.launches).toHaveLength(1);
    expect(runOf(h, run.id).status).toBe('failed');
  });

  it('a folder that is there is never rebuilt', async () => {
    const { h, run } = await failedRun();
    const done = h.world.runCheckouts.calls.length;
    await h.service.retry(run.id);
    await h.flush();
    expect(h.world.runCheckouts.calls.slice(done).some((call) => 'restore' in call)).toBe(false);
  });

  it("records what cleanup removed of a run's own checkout, and clears it once rebuilt; nothing on another run's (review S3)", async () => {
    const { h, run } = await failedRun();
    const removed = {
      commit: 'c1',
      keepRef: 'refs/consola/worktrees/catalog-portal-run-x',
      at: '2026-11-23T10:00:00.000Z',
    };
    h.service.recordCheckoutRemoved(run.id, removed);
    expect(runOf(h, run.id).checkout).toMatchObject({ kind: 'run-owned', removed });
    h.service.recordCheckoutRemoved(run.id, null);
    expect(runOf(h, run.id).checkout).not.toHaveProperty('removed');
    expect(runOf(h, run.id).checkout).toMatchObject({ kind: 'run-owned', base: 'b0' });
    h.service.recordCheckoutRemoved('no-such-run', removed);
  });

  it("names the run in history whose own checkout a folder is, by the host's path comparison (review NB2)", async () => {
    const { h, run } = await failedRun();
    const dir = ownedDir(h, run.id);
    expect(h.service.runOwningCheckout(dir)).toBe(run.id);
    expect(h.service.runOwningCheckout(`${dir}/`)).toBeNull();
    expect(
      h.service.runOwningCheckout(
        `${dir}/`,
        (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, ''),
      ),
    ).toBe(run.id);
    expect(h.service.runOwningCheckout('/elsewhere/catalog-portal-run-00000000')).toBeNull();
  });
});

describe('the approval card says what a write agent can change, read, reach and run (Task 21)', () => {
  const CLAUDE = { name: 'Claude', problem: null, stepProblem: null, cliVersion: '2.1.331' };
  const VERDICTS = { sandboxCheckedOn: '2.1.330', fileToolsChecked: true, hostEditChecked: true };

  it("fills an entry's writes from its definition, the host's verdicts and its harness's CLI version", async () => {
    const h = await harness(WRITE_ENTRY, {
      files: WRITER,
      harness: CLAUDE,
      cardVerdicts: VERDICTS,
    });
    const view = h.service.list(WORKSPACE_ID).find((entry) => entry.name === 'write')!;
    expect(view.writes).toEqual({
      checkout:
        "Cuts `fix/<run>` from sprocket/catalog-portal's default branch, in a checkout of its own. Nothing else is written.",
      agents: [
        {
          agent: 'fixer',
          head: 'fixer · default harness · default model · writes files and runs commands · environment sandboxed (sandbox, enforced on this Mac) · checked on Claude 2.1.330; this Mac runs 2.1.331',
          sentences: [expect.stringContaining(KEYCHAIN_SENTENCE)],
        },
      ],
      commands: [
        '`pr` · on host, after fixer: runs code an agent changed, as you, with your logins.',
      ],
      variables: 'Passes nothing from your environment.',
    });
    expect(view.writes!.agents[0].sentences[0]).toContain(
      "its file tools read only this run's checkout.",
    );
  });

  it('a host that passes no verdicts gets a card that says nothing was checked', async () => {
    const h = await harness(WRITE_ENTRY, { files: WRITER });
    const [written] = h.service.list(WORKSPACE_ID).find((entry) => entry.name === 'write')!
      .writes!.agents;
    expect(written.head).toMatch(/· not yet checked on any Claude version$/);
    expect(written.sentences[0]).toContain('its file tools were not checked against that list');
  });

  it('an entry of commands in its own checkout says what it cuts; one with neither has no writes', async () => {
    const h = await harness(RUN_OWNED, { cardVerdicts: VERDICTS });
    expect(h.service.list(WORKSPACE_ID)[0].writes).toEqual({
      checkout:
        "Cuts `consola/run-<run>` from sprocket/catalog-portal's default branch, in a checkout of its own. Nothing else is written.",
      agents: [],
      commands: [],
    });
    const plain = await harness(
      file(
        `  - name: plain\n    on: manual\n    mode: auto\n    scope: catalog-portal\n${steps('- id: check\n  run: "true"')}`,
      ),
    );
    expect(plain.service.snapshot(WORKSPACE_ID).issues).toEqual([]);
    expect(plain.service.list(WORKSPACE_ID)[0]).not.toHaveProperty('writes');
  });
});

describe('the run page, its pipeline and a restart’s notice (Task 22)', () => {
  const STOPPED = 'write stopped while it wrote';
  const told = (h: StepsHarness, title: string) =>
    h.notices.filter((notice) => notice.title === title);

  it('a restart that fails a write step tells the person, once', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    expect(told(h, STOPPED)).toEqual([]);
    const again = await h.relaunch();
    await again.flush();
    expect(stepOf(again, run.id, 'fix')).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_WRITE,
    });
    expect(told(again, STOPPED)).toEqual([
      {
        title: STOPPED,
        body: INTERRUPTED_WRITE,
        runId: run.id,
        workspaceId: WORKSPACE_ID,
        needsApproval: false,
      },
    ]);
    // The next start finds it failed already: no second notice.
    const third = await again.relaunch();
    await third.flush();
    expect(told(third, STOPPED)).toHaveLength(1);
  });

  it('a restart that fails a command, or puts a read-only step back in line, says nothing of writing', async () => {
    const h = await writing(WRITE_ENTRY);
    const run = await runNow(h, 'write');
    await h.world.endTurn('session-1', { exitCode: 0 });
    // `pr` declared its intent and Consola quit before its result.
    expect(stepOf(h, run.id, 'pr').status).toBe('running');
    const again = await h.relaunch();
    await again.flush();
    expect(runOf(again, run.id).status).toBe('failed');
    expect(
      again.notices.filter((notice) => notice.title.endsWith('stopped while it wrote')),
    ).toEqual([]);
  });

  it("a step's detail carries the changes an attempt kept, the latest first, and its path artifacts' paths", async () => {
    const h = await writing(POLL_WRITE);
    await check(h, 'poll-write', []);
    await check(h, 'poll-write', [{ key: 'SHOP-42' }]);
    const [run] = h.store.runs().filter((candidate) => candidate.automationId === 'poll-write');
    // Its path, rendered for the run's item: what the run page titles the artifact with.
    expect(h.service.getStepDetail(run.id, 'fix')!.paths).toEqual([
      { name: 'notes', path: 'docs/fixes/SHOP-42.md' },
    ]);
    expect(h.service.getStepDetail(run.id, 'fix')).not.toHaveProperty('changes');
    await h.world.endTurn(lastSession(h), { exitCode: 1, lastLine: 'Rate limited.' });
    expect(stepOf(h, run.id, 'fix').status).toBe('failed');
    const patch = 'diff --git a/src/app.ts b/src/app.ts\n-broken\n+fixed\n';
    const dir = h.folder.attemptDir(WORKSPACE_ID, run.id, 'fix', 1);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'changes.patch'), patch);
    expect(h.service.getStepDetail(run.id, 'fix')!.changes).toEqual({
      attempt: 1,
      text: patch,
      bytes: patch.length,
      truncated: false,
    });
    // After a Retry the step is attempt 2, which kept none yet: attempt 1's is still shown.
    await h.service.retry(run.id);
    await h.flush();
    expect(stepOf(h, run.id, 'fix').attempt).toBe(2);
    expect(h.service.getStepDetail(run.id, 'fix')!.changes).toMatchObject({ attempt: 1 });
    // An agent step that writes no file into the checkout has no paths.
    const plain = await writing(WRITE_ENTRY);
    const own = await runNow(plain, 'write');
    expect(plain.service.getStepDetail(own.id, 'fix')).not.toHaveProperty('paths');
    // A command's detail has neither.
    const pr = h.service.getStepDetail(run.id, 'pr')!;
    expect(pr).not.toHaveProperty('changes');
    expect(pr).not.toHaveProperty('paths');
  });

  it("lists each write step's isolation and the entry's own checkout, for its pipeline", async () => {
    const h = await writing(WRITE_ENTRY);
    const view = h.service.list(WORKSPACE_ID).find((entry) => entry.name === 'write')!;
    expect(view.checkout).toEqual({ repo: REPO, branch: 'fix/<run>' });
    expect(view.steps!.map((step) => [step.id, step.writes])).toEqual([
      ['fix', 'sandbox'],
      ['pr', undefined],
    ]);
    const onHost = await writing(
      WRITE_ENTRY,
      {},
      {
        'agents/fixer.md': '---\ntools: write\nenvironment: mine\n---\nFix it.\n',
        'environments/mine.yaml': 'isolation: host\n',
      },
    );
    const hosted = onHost.service.list(WORKSPACE_ID).find((entry) => entry.name === 'write')!;
    expect(hosted.steps!.find((step) => step.id === 'fix')!.writes).toBe('host');
    // A read-only agent's step in the same checkout writes nothing: no chip.
    const mixed = await writing(
      WRITE_ENTRY.replace(
        '- id: fix',
        '- id: look\n        agent: reader\n        prompt: Look.\n      - id: fix',
      ),
      {},
      { ...WRITER, 'agents/reader.md': '---\ndescription: Reads.\n---\nLook.\n' },
    );
    const both = mixed.service.list(WORKSPACE_ID).find((entry) => entry.name === 'write')!;
    expect(both.problem).toBeUndefined();
    expect(both.steps!.map((step) => [step.id, step.writes])).toEqual([
      ['look', undefined],
      ['fix', 'sandbox'],
      ['pr', undefined],
    ]);
    // An entry with neither draws neither.
    const plain = await harness(
      file(
        `  - name: plain\n    on: manual\n    mode: auto\n    scope: catalog-portal\n${steps('- id: check\n  run: "true"')}`,
      ),
    );
    const [only] = plain.service.list(WORKSPACE_ID);
    expect(only).not.toHaveProperty('checkout');
    expect(only.steps![0]).not.toHaveProperty('writes');
  });
});
