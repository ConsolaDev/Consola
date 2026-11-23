import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  automationVersion,
  parseFactorySpec,
  stableStringify,
  type StepRun,
} from '@consola/factory-spec';
import { listDefinition } from './AutomationService';
import { describe, expect, it, vi } from 'vitest';
import type { RunSecrets } from './secrets/runSecrets';
import { SecretReadError } from './secrets/secretsPort';
import { NO_SECRETS } from './secrets/unbound';
import { maskFormsOf } from './secrets/values';
import {
  BIND_HINT,
  stepsHarness,
  WORKSPACE_ID,
  type StepsHarness,
  type StepsHarnessOptions,
} from './steps/steps.test-helpers';

const HOUR = 60 * 60 * 1000;
const NAME = 'page';
const KEY = `${WORKSPACE_ID} ${NAME}`;
const NEEDS_PAGER = `needs \`PAGER_TOKEN\` bound ${BIND_HINT}`;

const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;

/** A daily `auto` entry in api whose one command step names `secrets` (none: no `secrets:` line). */
function paging(secrets = '[PAGER_TOKEN]', extra = '    scope: api\n'): string {
  const named = secrets ? `\n        secrets: ${secrets}` : '';
  return file(
    `  - name: ${NAME}\n    on: { cron: "0 9 * * 1-5" }\n${extra}    mode: auto\n    steps:\n      - id: page\n        run: page --service api${named}\n`,
  );
}
const PAGING = paging();

/** A keyed poll whose check names `TRACKER_TOKEN`. */
const WATCH = file(
  '  - name: watch\n    on: { poll: { every: 30m, run: tracker list, key: .id, secrets: [TRACKER_TOKEN] } }\n    scope: api\n    mode: auto\n    steps:\n      - id: look\n        prompt: Look at it.\n',
);

/** A run on a pull request a person picks, whose command names `PAGER_TOKEN`. */
const ON_DEMAND = file(
  '  - name: page-on-demand\n    on: manual\n    applies_to: [pr]\n    steps:\n      - id: page\n        run: page --pr "$PR"\n        env: { PR: "{{item.number}}" }\n        secrets: [PAGER_TOKEN]\n',
);
const PR_51 = { workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' as const } };

const PAGER_BINDING = {
  ref: 'keychain:consola/ws-1/personal/PAGER_TOKEN',
  label: 'the keychain (consola/ws-1/personal · PAGER_TOKEN)',
};
const TRACKER_BINDING = {
  ref: 'op://Ops/Tracker/credential',
  kind: '1password' as const,
  label: '1Password (op://Ops/Tracker/credential)',
};

const only = (yaml: string) => ({ ...parseFactorySpec(yaml).automations[0], file: 'factory.yml' });
const versionOf = (yaml: string) => automationVersion(only(yaml));

const row = (h: Awaited<ReturnType<typeof stepsHarness>>, name = NAME) =>
  h.service.list(WORKSPACE_ID).find((view) => view.name === name)!;
/** The row as the person's panel has it (the snapshot), where a failed read says where its name is bound. */
const personRow = (h: Awaited<ReturnType<typeof stepsHarness>>, name = NAME) =>
  h.service.snapshot(WORKSPACE_ID).automations.find((view) => view.name === name)!;

describe('an entry whose secrets are not all bound', () => {
  it('says which, and why, on its row, and keeps its own version', async () => {
    const h = await stepsHarness({ yaml: PAGING });
    expect(row(h)).toMatchObject({ problem: NEEDS_PAGER, unbound: ['PAGER_TOKEN'] });
    // Its uses are read against its own version: accepted at it, they say so.
    h.store.accept(KEY, versionOf(PAGING));
    await h.service.reload(WORKSPACE_ID);
    expect(h.service.snapshot(WORKSPACE_ID).secrets).toEqual([
      { name: 'PAGER_TOKEN', uses: [{ automation: NAME, step: 'page', accepted: true }] },
    ]);
  });

  it('cannot run now, and its time fires nothing', async () => {
    const h = await stepsHarness({ yaml: PAGING });
    await expect(h.service.trigger(WORKSPACE_ID, NAME)).rejects.toThrow(
      `${NAME} cannot run: ${NEEDS_PAGER}`,
    );
    h.advance(2 * HOUR);
    await h.tick();
    expect(h.store.runs()).toEqual([]);
    expect(h.world.commands).toEqual([]);
    expect(h.world.launches).toEqual([]);
    expect(h.world.secrets.resolved).toEqual([]);
  });

  it('gives one notice when it first needs a name, none on a reload or a relaunch', async () => {
    const h = await stepsHarness({ yaml: file() });
    await h.setYaml(PAGING);
    const titled = (title: string) => h.notices.filter((notice) => notice.title === title);
    const title = `\`${NAME}\` ${NEEDS_PAGER}`;
    expect(titled(title)).toEqual([
      {
        title,
        body: "It won't run until then. Review it in Consola.",
        workspaceId: WORKSPACE_ID,
        automation: NAME,
        needsApproval: false,
      },
    ]);
    await h.service.reload(WORKSPACE_ID);
    await h.service.syncWorkspaces();
    expect(titled(title)).toHaveLength(1);
    // Already there when Consola opens: the row says it, no notice does.
    const again = await h.relaunch();
    expect(again.notices.filter((notice) => notice.title === title)).toHaveLength(1);
    const fresh = await stepsHarness({ yaml: PAGING });
    expect(fresh.notices.filter((notice) => notice.title === title)).toEqual([]);
  });

  it('runs once bound, as the entry it was', async () => {
    const h = await stepsHarness({ yaml: PAGING });
    h.store.accept(KEY, versionOf(PAGING));
    await h.service.reload(WORKSPACE_ID);
    expect(row(h).asksFirst).toBeUndefined();
    h.world.secrets.bindings.set('PAGER_TOKEN', PAGER_BINDING);
    await h.service.reload(WORKSPACE_ID);
    const bound = row(h);
    expect(bound.problem).toBeUndefined();
    expect('unbound' in bound).toBe(false);
    // The same version: what was accepted while it was unbound still is.
    expect(bound.asksFirst).toBeUndefined();
    h.world.secrets.bindings.delete('PAGER_TOKEN');
    await h.service.reload(WORKSPACE_ID);
    expect(row(h).problem).toBe(NEEDS_PAGER);
  });

  it('is saved while unbound: a binding is machine state', async () => {
    const h = await stepsHarness({ yaml: file() });
    const entryYaml = paging().split('automations:\n')[1].replace(/^ {2}/gm, '');
    await expect(
      h.service.saveEntry(WORKSPACE_ID, entryYaml, { replace: false }),
    ).resolves.toMatchObject({ name: NAME });
    expect(row(h).problem).toBe(NEEDS_PAGER);
  });

  it('shows any other problem first', async () => {
    const h = await stepsHarness({ yaml: paging('[PAGER_TOKEN]', '    scope: nowhere\n') });
    expect(row(h).problem).not.toContain('PAGER_TOKEN');
    expect(row(h).problem).toContain('nowhere');
    expect('unbound' in row(h)).toBe(false);
  });

  it("does not check a poll whose check's secret is unbound, nor ask for its Allow", async () => {
    const h = await stepsHarness({ yaml: file() });
    await h.setYaml(WATCH);
    const view = row(h, 'watch');
    expect(view).toMatchObject({
      problem: `needs \`TRACKER_TOKEN\` bound ${BIND_HINT}`,
      unbound: ['TRACKER_TOKEN'],
    });
    expect(view.needsAllow).toBeUndefined();
    expect(h.notices.some((notice) => notice.title.includes('needs your OK'))).toBe(false);
    h.advance(HOUR);
    await h.tick();
    expect(h.world.commands).toEqual([]);
  });

  it('runs nothing meanwhile, so a dry run that would start a command does not ask first', async () => {
    const dry = paging('[PAGER_TOKEN]', '    scope: api\n').replace('mode: auto', 'mode: notify');
    const h = await stepsHarness({
      yaml: dry.replace('secrets: [PAGER_TOKEN]', 'secrets: [PAGER_TOKEN]\n        dry_run: run'),
    });
    expect(row(h).problem).toBe(NEEDS_PAGER);
    expect(row(h).asksFirst).toBeUndefined();
    h.world.secrets.bindings.set('PAGER_TOKEN', PAGER_BINDING);
    await h.service.reload(WORKSPACE_ID);
    expect(row(h).asksFirst).toBe(true);
  });

  it("says a runner with no port can't bind", async () => {
    const h = await stepsHarness({ yaml: PAGING, secrets: 'none' });
    expect(row(h)).toMatchObject({ problem: NO_SECRETS, unbound: ['PAGER_TOKEN'] });
  });

  it('leaves an entry that names none as it was', async () => {
    const plain = paging('');
    const rowOf = async (options: StepsHarnessOptions) =>
      row(await stepsHarness({ yaml: plain, ...options }));
    const none = await rowOf({ secrets: 'none' });
    expect(await rowOf({})).toEqual(none);
    expect(await rowOf({ secrets: { bindings: { PAGER_TOKEN: PAGER_BINDING } } })).toEqual(none);
    expect(none.problem).toBeUndefined();
  });

  it('puts the secrets in the snapshot only when there are some', async () => {
    const h = await stepsHarness({ yaml: paging('') });
    expect('secrets' in h.service.snapshot(WORKSPACE_ID)).toBe(false);
    h.world.secrets.bindings.set('TRACKER_TOKEN', TRACKER_BINDING);
    await h.service.reload(WORKSPACE_ID);
    expect(h.service.snapshot(WORKSPACE_ID).secrets).toEqual([
      {
        name: 'TRACKER_TOKEN',
        binding: {
          kind: '1password',
          label: TRACKER_BINDING.label,
          changedAt: '2026-11-16T08:00:00.000Z',
        },
        uses: [],
      },
    ]);
  });

  it('refuses Run on… for it too, and records no run', async () => {
    const h = await stepsHarness({ yaml: ON_DEMAND });
    const refused = `page-on-demand cannot run: ${NEEDS_PAGER}`;
    expect(() => h.service.listRunTargets(WORKSPACE_ID, 'page-on-demand')).toThrow(refused);
    await expect(h.service.trigger(WORKSPACE_ID, 'page-on-demand', {}, PR_51)).rejects.toThrow(
      refused,
    );
    await h.flush();
    expect(h.store.runs()).toEqual([]);
  });

  it('tells an agent names and flags, never where or what', async () => {
    const h = await stepsHarness({
      yaml: PAGING,
      secrets: { bindings: { PAGER_TOKEN: PAGER_BINDING, TRACKER_TOKEN: TRACKER_BINDING } },
    });
    expect(h.service.capabilities(WORKSPACE_ID).secrets).toEqual([
      { name: 'PAGER_TOKEN', bound: true },
      { name: 'TRACKER_TOKEN', bound: true },
    ]);
    const told = [
      JSON.stringify(h.service.capabilities(WORKSPACE_ID)),
      JSON.stringify(h.service.list(WORKSPACE_ID)),
    ];
    for (const text of told)
      for (const where of [
        PAGER_BINDING.label,
        TRACKER_BINDING.label,
        'consola/ws-1/personal',
        'op://',
        'keychain:',
      ])
        expect(text).not.toContain(where);
  });

  it('tells an agent no more once a check and a step failed to read, while the person sees where (review S1)', async () => {
    const yaml = file(
      `  - name: watch-tickets\n    on: { poll: { every: 30m, run: tracker list, key: .id, secrets: [TRACKER_TOKEN] } }\n    scope: api\n    mode: notify\n    steps:\n      - id: look\n        prompt: Look at it.\n`,
      paging().split('automations:\n')[1],
    );
    const h = await stepsHarness({
      yaml,
      secrets: { bindings: { PAGER_TOKEN: PAGER_BINDING, TRACKER_TOKEN: TRACKER_BINDING } },
    });
    for (const automation of parseFactorySpec(yaml).automations)
      h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation));
    await h.service.reload(WORKSPACE_ID);
    // A reason can name a reference too: an `env:` binding's variable.
    h.world.secrets.resolveThrows = new SecretReadError(
      'TRACKER_TOKEN',
      'your login environment has no `STUB_TRACKER_TOKEN`',
    );
    await h.service.trigger(WORKSPACE_ID, 'watch-tickets');
    await h.flush();
    h.world.secrets.resolveThrows = new SecretReadError(
      'PAGER_TOKEN',
      'the keychain has no such item',
    );
    const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
    await h.flush();
    expect(h.store.get(run.id)!.steps![0]).toMatchObject({
      status: 'failed',
      error: `Couldn't read \`PAGER_TOKEN\` from ${PAGER_BINDING.label}: the keychain has no such item. Nothing ran.`,
    });
    expect(personRow(h, 'watch-tickets').check!.error).toBe(
      `Couldn't read \`TRACKER_TOKEN\` from ${TRACKER_BINDING.label}: your login environment has no \`STUB_TRACKER_TOKEN\`; nothing ran.`,
    );
    expect(row(h, 'watch-tickets').check!.error).toBe(
      `Couldn't read \`TRACKER_TOKEN\` from its binding ${BIND_HINT}; nothing ran.`,
    );
    const told = [
      JSON.stringify(h.service.capabilities(WORKSPACE_ID)),
      JSON.stringify(h.service.list(WORKSPACE_ID)),
    ];
    for (const text of told)
      for (const where of [
        PAGER_BINDING.label,
        TRACKER_BINDING.label,
        'consola/ws-1/personal',
        'op://',
        'keychain',
        '1Password',
        'STUB_TRACKER_TOKEN',
        'no such item',
      ])
        expect(text).not.toContain(where);
  });
});

// --- a run's values (Task 7) ---------------------------------------------------

const PAGER_VALUE = 'stub-pager-secret-7f3a"\\back%slash\nline two!';
const TRACKER_VALUE = 'stub-tracker-secret-9c1e+/=';
const BOUND: StepsHarnessOptions['secrets'] = {
  bindings: { PAGER_TOKEN: PAGER_BINDING, TRACKER_TOKEN: TRACKER_BINDING },
  values: { PAGER_TOKEN: PAGER_VALUE, TRACKER_TOKEN: TRACKER_VALUE },
};

/** A daily `auto` entry in api: `name`, its steps as written (each a list item's lines). */
function entryOf(name: string, ...steps: string[]): string {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  return `  - name: ${name}\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n${items}\n`;
}
const TRIAGE = '- id: triage\n  prompt: Look at what api logged overnight.';
const PAGE = '- id: page\n  run: page --service api\n  secrets: [PAGER_TOKEN]';
const POST = '- id: post\n  run: post --tracker api\n  secrets: [TRACKER_TOKEN]';
const TIDY = '- id: tidy\n  run: git status';
const CHAIN = file(entryOf('chain', TRIAGE, PAGE, POST, TIDY));

/** Started on `yaml`, its entries accepted, so a person's Run now goes straight in line. */
async function accepted(yaml: string, options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  const h = await stepsHarness({ yaml, secrets: BOUND, ...options });
  for (const automation of parseFactorySpec(yaml).automations)
    h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation));
  await h.service.reload(WORKSPACE_ID);
  return h;
}
async function runNow(h: StepsHarness, name: string): Promise<string> {
  const run = (await h.service.trigger(WORKSPACE_ID, name))!;
  await h.flush();
  return run.id;
}
const stepOf = (h: StepsHarness, runId: string, id: string): StepRun =>
  h.store.get(runId)!.steps!.find((step) => step.id === id)!;
const attemptFile = (h: StepsHarness, runId: string, stepId: string, name: string, attempt = 1) =>
  path.join(h.folder.attemptDir(WORKSPACE_ID, runId, stepId, attempt), name);
const heldBy = (h: StepsHarness) => (h.service as unknown as { runSecrets: RunSecrets }).runSecrets;
/** Every file under a run's folder, by path, as text. */
function filesUnder(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [file, text] of filesUnder(full)) found.set(file, text);
    else found.set(full, fs.readFileSync(full, 'utf8'));
  }
  return found;
}

describe("a run's secrets", () => {
  it('are read once, all at once, before its first step, and never reach an agent', async () => {
    const h = await accepted(CHAIN);
    await runNow(h, 'chain');
    expect(h.world.secrets.resolved).toEqual([['PAGER_TOKEN', 'TRACKER_TOKEN']]);
    expect(h.world.secrets.resolvedAt).toEqual([0]);
    expect(h.world.launches).toHaveLength(1);
    const launched = JSON.stringify(h.world.launches[0]);
    for (const form of [...maskFormsOf(PAGER_VALUE), ...maskFormsOf(TRACKER_VALUE)])
      expect(launched).not.toContain(form);
  });

  it('gives each command only its own, every mask on each, and says so in its files and record', async () => {
    const h = await accepted(CHAIN);
    const runId = await runNow(h, 'chain');
    await h.world.endTurn('session-1');
    const [page] = h.world.commands;
    expect(page.spec.env.PAGER_TOKEN).toBe(PAGER_VALUE);
    expect('TRACKER_TOKEN' in page.spec.env).toBe(false);
    await page.end();
    const post = h.world.commands[1];
    expect(post.spec.env.TRACKER_TOKEN).toBe(TRACKER_VALUE);
    expect('PAGER_TOKEN' in post.spec.env).toBe(false);
    for (const spec of [page.spec, post.spec])
      for (const form of [...maskFormsOf(PAGER_VALUE), ...maskFormsOf(TRACKER_VALUE), 'gho_stub'])
        expect(spec.secrets).toContain(form);
    await post.end();
    const tidy = h.world.commands[2];
    expect(Object.keys(tidy.spec.env)).not.toContain('PAGER_TOKEN');
    expect(tidy.spec.secrets).toEqual(expect.arrayContaining(maskFormsOf(PAGER_VALUE)));
    await tidy.end();

    expect(
      JSON.parse(fs.readFileSync(attemptFile(h, runId, 'page', 'command.json'), 'utf8')),
    ).toEqual({
      cwd: '/code/api',
      command: 'page --service api',
      env: [],
      secrets: [{ name: 'PAGER_TOKEN', secret: true, bound: PAGER_BINDING.label }],
    });
    expect(stepOf(h, runId, 'page').command).toMatchObject({
      envNames: [],
      secretNames: ['PAGER_TOKEN'],
      intentAt: expect.any(String),
    });
    expect('secretNames' in stepOf(h, runId, 'tidy').command!).toBe(false);
    expect(h.service.getStepDetail(runId, 'page')?.command?.secrets).toEqual([
      { name: 'PAGER_TOKEN', bound: PAGER_BINDING.label },
    ]);
    expect(h.store.get(runId)!.status).toBe('completed');

    // A step that names none writes the command.json it wrote before secrets existed.
    const plain = await accepted(file(entryOf('tidy-only', TIDY)), { secrets: 'none' });
    const plainRun = await runNow(plain, 'tidy-only');
    await plain.world.commands[0].end();
    expect(fs.readFileSync(attemptFile(h, runId, 'tidy', 'command.json'), 'utf8')).toBe(
      fs.readFileSync(attemptFile(plain, plainRun, 'tidy', 'command.json'), 'utf8'),
    );
  });

  it('fail the step before it starts when one cannot be read, and nothing runs', async () => {
    const h = await accepted(CHAIN);
    h.world.secrets.resolveThrows = new SecretReadError(
      'TRACKER_TOKEN',
      'the keychain has no such item',
    );
    const runId = await runNow(h, 'chain');
    const words = `Couldn't read \`TRACKER_TOKEN\` from ${TRACKER_BINDING.label}: the keychain has no such item. Nothing ran.`;
    expect(stepOf(h, runId, 'triage')).toMatchObject({ status: 'failed', error: words });
    expect(h.store.get(runId)!.status).toBe('failed');
    expect(h.world.launches).toEqual([]);
    expect(h.world.commands).toEqual([]);
    expect(h.notices.some((notice) => `${notice.title} ${notice.body}`.includes(words))).toBe(true);
  });

  it('do not hold up the line while a read waits', async () => {
    let release!: () => void;
    const h = await accepted(file(entryOf('pager', PAGE), entryOf('tidy-only', TIDY)), {
      maxConcurrentCommands: 2,
    });
    h.world.secrets.resolveGate = new Promise((resolve) => (release = resolve));
    const pager = await runNow(h, 'pager');
    await runNow(h, 'tidy-only');
    expect(h.world.commands.map((command) => command.spec.command)).toEqual(['git status']);
    expect(stepOf(h, pager, 'page').status).toBe('queued');
    release();
    await h.flush();
    expect(h.world.commands.map((command) => command.spec.command)).toEqual([
      'git status',
      'page --service api',
    ]);
  });

  it('are read again before the next step after a restart, and the new binding counts', async () => {
    const h = await accepted(file(entryOf('pair', PAGE, POST)));
    const runId = await runNow(h, 'pair');
    // The line closes before post can start: it stays queued across the restart.
    h.world.maxConcurrentCommands = 0;
    await h.world.commands[0].end();
    expect(stepOf(h, runId, 'post').status).toBe('queued');
    h.world.secrets.values.set('TRACKER_TOKEN', 'stub-tracker-secret-rebound');
    h.world.maxConcurrentCommands = undefined;
    const again = await h.relaunch();
    await again.flush();
    expect(again.world.secrets.resolved).toHaveLength(2);
    expect(again.world.commands[1].spec.env.TRACKER_TOKEN).toBe('stub-tracker-secret-rebound');
  });

  it('are not read before a turn that resumes in its session; the next step reads, and fails alone', async () => {
    const h = await accepted(file(entryOf('triaged', TRIAGE, PAGE)));
    const runId = await runNow(h, 'triaged');
    expect(h.world.secrets.resolved).toHaveLength(1);
    expect(h.world.launches).toHaveLength(1);
    h.world.secrets.resolveThrows = new SecretReadError(
      'PAGER_TOKEN',
      'the keychain asked for permission and nobody answered within 30 seconds',
    );
    const again = await h.relaunch();
    await again.flush();
    expect(again.world.resumes).toHaveLength(1);
    expect(again.world.launches).toHaveLength(1);
    expect(again.world.secrets.resolved).toHaveLength(1);
    await again.world.endTurn(again.world.resumes[0].sessionId);
    expect(again.world.secrets.resolved).toHaveLength(2);
    expect(stepOf(again, runId, 'triage').status).toBe('completed');
    expect(stepOf(again, runId, 'page')).toMatchObject({
      status: 'failed',
      error: `Couldn't read \`PAGER_TOKEN\` from ${PAGER_BINDING.label}: the keychain asked for permission and nobody answered within 30 seconds. Nothing ran.`,
    });
    expect(again.world.commands).toEqual([]);
  });

  it('go with the run: a retry after a failure, or after a stop, reads again', async () => {
    const h = await accepted(file(entryOf('pager', PAGE)));
    const runId = await runNow(h, 'pager');
    expect(heldBy(h).held(runId)).toBeDefined();
    await h.world.commands[0].end({ result: { exitCode: 1 } });
    expect(h.store.get(runId)!.status).toBe('failed');
    expect(heldBy(h).held(runId)).toBeUndefined();
    await h.service.retry(runId);
    await h.flush();
    expect(h.world.secrets.resolved).toHaveLength(2);
    expect(h.world.commands).toHaveLength(2);

    h.service.stop(runId);
    await h.world.commands[1].end({ result: { exitCode: null, signal: 'SIGTERM', stopped: true } });
    expect(h.store.get(runId)!.status).toBe('failed');
    await h.service.retry(runId);
    await h.flush();
    expect(h.world.secrets.resolved).toHaveLength(3);
  });

  it('are never handed out once let go of, even mid-start', async () => {
    let release!: () => void;
    const h = await accepted(file(entryOf('pager', PAGE)));
    h.world.commandEnvGate = new Promise((resolve) => (release = resolve));
    const runId = await runNow(h, 'pager');
    expect(h.world.commandEnvAsked).toEqual([WORKSPACE_ID]);
    heldBy(h).drop(runId);
    release();
    await h.flush();
    expect(h.world.commands).toEqual([]);
    expect(stepOf(h, runId, 'page')).toMatchObject({
      status: 'failed',
      error:
        'Its environment could not be prepared (its secrets were not read before it started); nothing ran.',
    });
  });

  it('are let go of at a quit', async () => {
    const h = await accepted(file(entryOf('pager', PAGE)));
    const runId = await runNow(h, 'pager');
    expect(heldBy(h).held(runId)).toBeDefined();
    h.service.shutdown();
    expect(heldBy(h).held(runId)).toBeUndefined();
  });

  it("let go of a deleted workspace's running runs' values", async () => {
    const h = await accepted(file(entryOf('pager', PAGE)));
    const runId = await runNow(h, 'pager');
    expect(heldBy(h).held(runId)).toBeDefined();
    h.world.workspaceDeleted = true;
    await h.service.syncWorkspaces();
    expect(heldBy(h).held(runId)).toBeUndefined();
    expect(h.world.commands[0].stops).toBe(1);
  });

  it('in a dry run, are only those of what runs', async () => {
    const dry = (name: string, ...steps: string[]) =>
      entryOf(name, ...steps).replace('mode: auto', 'mode: notify');
    const h = await accepted(
      file(
        dry('notes', `${PAGE}\n  dry_run: report`, `${POST}\n  dry_run: run`),
        dry('reports', `${PAGE}\n  dry_run: report`),
      ),
    );
    const runId = await runNow(h, 'notes');
    expect(h.world.secrets.resolved).toEqual([['TRACKER_TOKEN']]);
    expect(
      JSON.parse(fs.readFileSync(attemptFile(h, runId, 'page', 'command.json'), 'utf8')).secrets,
    ).toEqual([{ name: 'PAGER_TOKEN', secret: true }]);
    await runNow(h, 'reports');
    expect(h.world.secrets.resolved).toEqual([['TRACKER_TOKEN']]);
  });
});

describe("a value's printed forms", () => {
  const firstLine = PAGER_VALUE.split('\n')[0];
  const NOTED = file(entryOf('noted', `${PAGE}\n  outputs: { note: string }`));
  const printed = () => ({
    stdout: `${PAGER_VALUE}\n`,
    stderr: [
      JSON.stringify(PAGER_VALUE).slice(1, -1),
      encodeURIComponent(PAGER_VALUE),
      `Authorization: Basic ${Buffer.from(`u:${PAGER_VALUE}`).toString('base64')}`,
      `failed for ${PAGER_VALUE}`,
    ].join('\n'),
    outputs: `note=${firstLine}\n`,
  });

  it('are in nothing Consola writes, its $CONSOLA_OUTPUT included, when the command fails', async () => {
    const h = await accepted(NOTED);
    const runId = await runNow(h, 'noted');
    await h.world.commands[0].end({
      ...printed(),
      result: { exitCode: 1, lastStderrLine: `failed for ${firstLine}` },
    });
    const step = stepOf(h, runId, 'page');
    expect(step.status).toBe('failed');
    expect(step.error).toContain('***');
    const files = filesUnder(h.folder.runDir(WORKSPACE_ID, runId));
    expect(fs.readFileSync(attemptFile(h, runId, 'page', 'outputs.env'), 'utf8')).toBe(
      'note=***\n',
    );
    const everything = [
      ...files.values(),
      JSON.stringify(h.history.appends),
      JSON.stringify([...h.history.logs]),
      JSON.stringify(h.store.get(runId)),
      step.error ?? '',
      ...h.notices.map((notice) => `${notice.title}\n${notice.body}`),
    ];
    for (const text of everything)
      for (const form of maskFormsOf(PAGER_VALUE)) expect(text).not.toContain(form);
    expect(fs.readFileSync(attemptFile(h, runId, 'page', 'stdout.log'), 'utf8')).toContain('***');
    expect(fs.readFileSync(attemptFile(h, runId, 'page', 'stderr.log'), 'utf8')).toContain('***');
  });

  it('are masked in its outputs when it succeeds', async () => {
    const h = await accepted(NOTED);
    const runId = await runNow(h, 'noted');
    await h.world.commands[0].end(printed());
    expect(stepOf(h, runId, 'page')).toMatchObject({
      status: 'completed',
      outputs: { note: '***' },
    });
    expect(fs.readFileSync(attemptFile(h, runId, 'page', 'outputs.env'), 'utf8')).toBe(
      'note=***\n',
    );
    expect(
      JSON.parse(fs.readFileSync(attemptFile(h, runId, 'page', 'outputs.json'), 'utf8')),
    ).toEqual({
      note: '***',
    });
  });

  it('leave nothing of a $CONSOLA_OUTPUT too big to read and mask', async () => {
    const h = await accepted(NOTED);
    const runId = await runNow(h, 'noted');
    await h.world.commands[0].end({ outputs: `note=${firstLine}\n${'x'.repeat(70 * 1024)}\n` });
    expect(stepOf(h, runId, 'page')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Could not read its $CONSOLA_OUTPUT ('),
    });
    expect(fs.readFileSync(attemptFile(h, runId, 'page', 'outputs.env'), 'utf8')).toBe('');
  });

  it('leave a $CONSOLA_OUTPUT with nothing to mask as the command wrote it', async () => {
    const h = await accepted(NOTED);
    const writeText = vi.spyOn(h.folder, 'writeText');
    const runId = await runNow(h, 'noted');
    await h.world.commands[0].end({ outputs: 'note=all quiet\n' });
    expect(fs.readFileSync(attemptFile(h, runId, 'page', 'outputs.env'), 'utf8')).toBe(
      'note=all quiet\n',
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(stepOf(h, runId, 'page').status).toBe('completed');
  });
});

// --- a check's values (Task 8) -------------------------------------------------

const TICKETS = 'watch-tickets';
const TICKETS_KEY = `${WORKSPACE_ID} ${TICKETS}`;
const WATCH_TICKETS = file(
  `  - name: ${TICKETS}\n    on: { poll: { every: 30m, run: tracker list, key: .id, secrets: [TRACKER_TOKEN] } }\n    scope: api\n    mode: notify\n    steps:\n      - id: look\n        prompt: Look at it.\n`,
);
const items = (...ids: string[]) =>
  JSON.stringify(ids.map((id) => ({ id, title: `Ticket ${id}` })));

/** Sprocket with `watch-tickets` allowed: its first check has started. */
async function watching(options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  const h = await stepsHarness({ yaml: WATCH_TICKETS, secrets: BOUND, ...options });
  const shown = row(h, TICKETS);
  expect(shown).toMatchObject({ needsAllow: true });
  h.service.allow(WORKSPACE_ID, TICKETS, shown.version!);
  await h.flush();
  return h;
}
/** Ends the latest check command with `stdout`, or as `how` says. */
async function endCheck(
  h: StepsHarness,
  how: Parameters<StepsHarness['world']['commands'][0]['end']>[0],
) {
  const command = h.world.commands[h.world.commands.length - 1];
  expect(command.spec.command).toBe('tracker list');
  await command.end(how);
}
async function checkNow(h: StepsHarness): Promise<void> {
  await h.service.trigger(WORKSPACE_ID, TICKETS);
  await h.flush();
}
const checkView = (h: StepsHarness) => row(h, TICKETS).check!;
const seenItems = (h: StepsHarness) => h.store.seen(TICKETS_KEY)?.items ?? [];

describe("a check's secrets", () => {
  it('are read before each check, given to its command, and masked', async () => {
    const h = await watching();
    expect(h.world.secrets.resolved).toEqual([['TRACKER_TOKEN']]);
    const [check] = h.world.commands;
    expect(check.spec.env.TRACKER_TOKEN).toBe(TRACKER_VALUE);
    expect(check.spec.secrets).toEqual(expect.arrayContaining(maskFormsOf(TRACKER_VALUE)));
    await endCheck(h, { stdout: items() });
    await checkNow(h);
    expect(h.world.secrets.resolved).toHaveLength(2);
    expect(h.world.commands).toHaveLength(2);
  });

  it('that cannot be read fail the check: nothing runs, and one notice for a run of failures', async () => {
    const h = await stepsHarness({ yaml: WATCH_TICKETS, secrets: BOUND });
    h.world.secrets.resolveThrows = new SecretReadError(
      'TRACKER_TOKEN',
      'the keychain has no such item',
    );
    h.service.allow(WORKSPACE_ID, TICKETS, row(h, TICKETS).version!);
    await h.flush();
    const error = `Couldn't read \`TRACKER_TOKEN\` from ${TRACKER_BINDING.label}: the keychain has no such item; nothing ran.`;
    expect(personRow(h, TICKETS).check!.error).toBe(error);
    // What `list_automations` hands an agent names the secret, never where it is bound (review S1).
    expect(checkView(h).error).toBe(
      `Couldn't read \`TRACKER_TOKEN\` from its binding ${BIND_HINT}; nothing ran.`,
    );
    h.advance(2 * HOUR);
    await h.tick();
    expect(h.world.secrets.resolved).toHaveLength(2);
    expect(h.world.commands).toEqual([]);
    expect(
      h.notices.filter((notice) => notice.title === `\`${TICKETS}\` can't check: ${error}`),
    ).toHaveLength(1);
  });

  it('are masked in what a failed check says, and in the items a check keeps', async () => {
    const h = await watching();
    await endCheck(h, {
      stderr: `token ${TRACKER_VALUE} refused`,
      result: { exitCode: 1, lastStderrLine: `token ${TRACKER_VALUE} refused` },
    });
    const told = [checkView(h).error ?? '', ...h.notices.map((notice) => notice.title)];
    expect(checkView(h).error).toContain('***');
    for (const text of told)
      for (const form of maskFormsOf(TRACKER_VALUE)) expect(text).not.toContain(form);

    // A first good check baselines; the next fires what it finds, with the value masked in its item.
    await checkNow(h);
    await endCheck(h, { stdout: items() });
    await checkNow(h);
    await endCheck(h, { stdout: JSON.stringify([{ id: 'a', title: `Leaked ${TRACKER_VALUE}` }]) });
    expect(checkView(h).fired).toBe(1);
    const [run] = h.store.runs();
    const item = fs.readFileSync(
      path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'item.json'),
      'utf8',
    );
    expect(item).toContain('***');
    for (const form of maskFormsOf(TRACKER_VALUE)) expect(item).not.toContain(form);
  });

  it('rebound, baseline the next check; unchanged, it fires', async () => {
    const fired = async (rebind: boolean) => {
      const h = await watching();
      await endCheck(h, { stdout: items() });
      await checkNow(h);
      await endCheck(h, { stdout: items('a') });
      expect(checkView(h).fired).toBe(1);
      if (rebind)
        h.world.secrets.bindings.set('TRACKER_TOKEN', {
          ...TRACKER_BINDING,
          ref: 'op://Ops/Tracker2/credential',
        });
      await h.service.reload(WORKSPACE_ID);
      await checkNow(h);
      await endCheck(h, { stdout: items('a', 'b') });
      return h;
    };
    const rebound = await fired(true);
    expect(checkView(rebound)).toMatchObject({ fired: 0, baseline: true });
    expect(seenItems(rebound).some((key) => key.endsWith('b'))).toBe(true);
    const same = await fired(false);
    expect(checkView(same).fired).toBe(1);
  });

  it('rebound while a check runs, drop its result, and the next check baselines', async () => {
    const h = await watching();
    await endCheck(h, { stdout: items() });
    await checkNow(h);
    await endCheck(h, { stdout: items('a') });
    const before = seenItems(h);
    await checkNow(h);
    expect(h.world.commands).toHaveLength(3);
    h.world.secrets.bindings.set('TRACKER_TOKEN', {
      ...TRACKER_BINDING,
      ref: 'op://Ops/Tracker2/credential',
    });
    await h.service.reload(WORKSPACE_ID);
    await endCheck(h, { stdout: items('a', 'b') });
    expect(seenItems(h)).toEqual(before);
    const runs = h.store.runs().length;
    await checkNow(h);
    await endCheck(h, { stdout: items('x', 'y') });
    expect(h.store.runs()).toHaveLength(runs);
    expect(seenItems(h).filter((key) => key.endsWith('x') || key.endsWith('y'))).toHaveLength(2);
    expect(checkView(h)).toMatchObject({ fired: 0, baseline: true });
  });

  it('rebound while a check reads them, drop the check before its command starts', async () => {
    let release!: () => void;
    const h = await watching();
    await endCheck(h, { stdout: items() });
    h.world.secrets.resolveGate = new Promise((resolve) => (release = resolve));
    await checkNow(h);
    h.world.secrets.bindings.set('TRACKER_TOKEN', {
      ...TRACKER_BINDING,
      ref: 'op://Ops/Tracker2/credential',
    });
    await h.service.reload(WORKSPACE_ID);
    release();
    await h.flush();
    // The check that read under the old binding started nothing; the one after it, under the new, did.
    expect(h.world.secrets.resolved).toHaveLength(3);
    expect(h.world.commands).toHaveLength(2);
    await endCheck(h, { stdout: items('a') });
    expect(checkView(h)).toMatchObject({ fired: 0, baseline: true });
  });

  it('are read before the entry is asked again: an edit while they are read drops the check', async () => {
    let release!: () => void;
    const h = await watching();
    await endCheck(h, { stdout: items() });
    h.world.secrets.resolveGate = new Promise((resolve) => (release = resolve));
    await checkNow(h);
    await h.setYaml(WATCH_TICKETS.replace('tracker list', 'tracker list --open'));
    release();
    await h.flush();
    expect(h.world.commands).toHaveLength(1);
  });

  it('leave a poll that names none on the definition it had', () => {
    const automation = {
      ...parseFactorySpec(
        file(
          '  - name: watch\n    on: { poll: { every: 30m, run: tracker list, key: .id } }\n    scope: api\n    run: { prompt: "Look." }\n',
        ),
      ).automations[0],
    };
    const provider = { id: 'github', accountLogin: 'JaviDev' };
    const { everyMs: _every, ...trigger } = automation.trigger as { everyMs: number };
    const before = createHash('sha256')
      .update(
        stableStringify({
          trigger,
          filter: automation.filter,
          account: { id: 'github', login: 'JaviDev', org: undefined },
        }),
      )
      .digest('hex')
      .slice(0, 16);
    expect(listDefinition({ automation }, provider)).toBe(before);
    expect(listDefinition({ automation }, provider, undefined)).toBe(before);
    expect(listDefinition({ automation }, provider, { TRACKER_TOKEN: 'fp' })).not.toBe(before);
  });

  it('keep the seen record of a poll that names none on the definition it had', async () => {
    const plain = WATCH_TICKETS.replace(', secrets: [TRACKER_TOKEN]', '');
    const h = await stepsHarness({ yaml: plain, secrets: BOUND });
    h.service.allow(WORKSPACE_ID, TICKETS, row(h, TICKETS).version!);
    await h.flush();
    await endCheck(h, { stdout: items('a') });
    const automation = parseFactorySpec(plain).automations[0];
    const { everyMs: _every, ...trigger } = automation.trigger as { everyMs: number };
    expect(h.store.seen(TICKETS_KEY)?.definition).toBe(
      createHash('sha256')
        .update(
          stableStringify({
            trigger,
            filter: automation.filter,
            account: { id: 'github', login: 'JaviDev', org: undefined },
          }),
        )
        .digest('hex')
        .slice(0, 16),
    );
  });
});
