import { automationVersion, cleanBranchPart, parseFactorySpec } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import { inboxItem } from './inboxItems.test-helpers';
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
    expect(stepCommands(h)[0].spec.env.CONSOLA_CHECKOUT_HEAD).toBeUndefined();
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
    const yaml = EVENT_OWNED.replace('- id: check\n        run: "true"', '- id: look\n        prompt: Look at it.');
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
