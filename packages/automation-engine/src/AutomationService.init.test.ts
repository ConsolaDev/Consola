import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationVersion, parseFactorySpec, stableStringify } from '@consola/factory-spec';
import {
  stepsHarness,
  turnReport,
  WORKSPACE_ID,
  type StepsHarness,
  type StepsHarnessOptions,
} from './steps/steps.test-helpers';

/*
 * The `init` check: a step's turn printed its `system/init`, and every server
 * its agent grants must be there and connected. No agent grants a server
 * until slice 2-C, so `requiredServers` is mocked here: it reads a holder
 * each test sets, `[]` (what 2-A really returns) unless the test says.
 */

const required = vi.hoisted(() => ({ servers: [] as Array<{ name: string }> }));
vi.mock('./steps/turnReport', async (original) => ({
  ...(await original<typeof import('./steps/turnReport')>()),
  requiredServers: () => required.servers,
}));
beforeEach(() => {
  required.servers = [];
});

// Copied from AutomationService.steps.test.ts, where they are module-local.

/** One `- name:` entry: its `on:` and other keys as given, then `steps:` with each item's lines. */
function entry(name: string, head: string, ...steps: string[]): string {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  return `  - name: ${name}\n${head}    steps:\n${items}\n`;
}
const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;
const DAILY_IN_API = '    on: { cron: "0 9 * * 1-5" }\n    scope: api\n';

/** Accept every entry in `yaml` at its current version, so each runs on its own. */
function acceptEvery(h: StepsHarness, yaml: string): void {
  for (const automation of parseFactorySpec(yaml).automations) {
    const bodies: Record<string, string> = {};
    for (const step of automation.steps ?? []) {
      if (step.kind === 'agent' && step.action)
        bodies[step.id] = h.world.workspace.actions.find(
          (action) => action.name === step.action,
        )!.prompt;
    }
    const body = Object.keys(bodies).length > 0 ? stableStringify(bodies) : undefined;
    h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation, body));
  }
}

const DAILY_AUTO = `${DAILY_IN_API}    mode: auto\n`;
/** A first step that decides how the night went, and a second that writes it up. */
const ONE =
  '- id: one\n  prompt: Read what changed in api overnight.\n  outputs:\n    mood: { enum: [calm, worrying] }';
const TWO = '- id: two\n  prompt: Write up the {{steps.one.mood}} night for the team.';
const NIGHTLY = entry('nightly', DAILY_AUTO, ONE, TWO);

/** A started harness over `yaml`, every entry in it accepted, so each runs on its own. */
async function accepted(yaml: string, options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  const h = await stepsHarness({ yaml, ...options });
  acceptEvery(h, yaml);
  return h;
}

/** The nightly run, its first step's turn running in session-1. */
async function started() {
  const h = await accepted(file(NIGHTLY));
  const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
  await h.flush();
  return { h, run };
}

const STOPPED = 'a server it needs was not connected';
const HINT = 'run `claude`, then /mcp';

describe('a step turn’s init, with no server granted (2-A)', () => {
  it('changes nothing', async () => {
    const { h, run } = await started();
    h.service.turnStarted('session-1', { servers: [] });
    expect(h.world.stops).toEqual([]);
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1', { exitCode: 0, report: turnReport({}) });
    expect(h.store.get(run.id)?.steps?.[0].status).toBe('completed');
  });

  it("puts init's model on the running step at once", async () => {
    const { h, run } = await started();
    const broadcasts = h.world.broadcasts.length;
    h.service.turnStarted('session-1', { model: 'claude-opus-5-5', servers: [] });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'running',
      model: 'claude-opus-5-5',
    });
    // The windows hear it while the turn runs.
    expect(h.world.broadcasts.length).toBeGreaterThan(broadcasts);
  });

  it('an init with no model leaves the model absent', async () => {
    const { h, run } = await started();
    h.service.turnStarted('session-1', { servers: [] });
    expect(h.store.get(run.id)?.steps?.[0]).not.toHaveProperty('model');
  });
});

describe('a step turn’s init, with a server granted', () => {
  beforeEach(() => {
    required.servers = [{ name: 'grafana' }];
  });

  it('a granted server missing from init stops the turn, and the step fails with the engine words', async () => {
    const { h, run } = await started();
    h.service.turnStarted('session-1', { servers: [{ name: 'consola', status: 'connected' }] });
    expect(h.world.stops).toEqual([{ sessionId: 'session-1', reason: STOPPED }]);
    await h.world.endTurn('session-1', {
      exitCode: 0,
      stopped: STOPPED,
      report: turnReport({ noResult: true, cost: 0.002 }),
    });
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      steps: [
        {
          id: 'one',
          status: 'failed',
          error:
            '`grafana` was not loaded: it was removed from Claude, or it is blocked by its URL.',
        },
        { id: 'two', status: 'not-run' },
      ],
    });
  });

  it('its words win even when the turn went on to finish cleanly, and its cost is recorded', async () => {
    // The CLI would have run the turn without the server: never `completed`.
    const { h, run } = await started();
    h.service.turnStarted('session-1', { servers: [] });
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1', {
      exitCode: 0,
      report: turnReport({ cost: 0.0123, turns: 2 }),
    });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error: '`grafana` was not loaded: it was removed from Claude, or it is blocked by its URL.',
      turn: { costUsd: 0.0123, turns: 2 },
    });
    expect(h.store.get(run.id)?.costUsd).toBe(0.0123);
    expect(h.world.reminders).toEqual([]);
  });

  it("a granted server not connected fails with the driver's hint", async () => {
    const { h, run } = await started();
    h.service.turnStarted('session-1', {
      servers: [{ name: 'grafana', status: 'needs-auth' }],
      signInHint: HINT,
    });
    expect(h.world.stops).toEqual([{ sessionId: 'session-1', reason: STOPPED }]);
    await h.world.endTurn('session-1', { exitCode: 0, stopped: STOPPED, report: turnReport({}) });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error:
        '`grafana` was not connected (needs-auth). Sign in to it in Claude (run `claude`, then /mcp), then retry this step.',
    });
  });

  it('pending counts as not connected', async () => {
    const { h, run } = await started();
    h.service.turnStarted('session-1', {
      servers: [{ name: 'grafana', status: 'pending' }],
      signInHint: HINT,
    });
    await h.world.endTurn('session-1', { exitCode: 0, stopped: STOPPED, report: turnReport({}) });
    expect(h.store.get(run.id)?.steps?.[0].error).toBe(
      '`grafana` was not connected (pending). Sign in to it in Claude (run `claude`, then /mcp), then retry this step.',
    );
  });

  it('a connected server is no problem', async () => {
    const { h, run } = await started();
    // The report carries the init the start heard, as the host's does.
    const init = { servers: [{ name: 'grafana', status: 'connected' }] };
    h.service.turnStarted('session-1', init);
    expect(h.world.stops).toEqual([]);
    h.world.setOutputs('session-1', { mood: 'calm' });
    await h.world.endTurn('session-1', { exitCode: 0, report: { ...turnReport({}), init } });
    expect(h.store.get(run.id)?.steps?.[0].status).toBe('completed');
  });

  it('an init for a session with no running step is ignored', async () => {
    const { h, run } = await started();
    const before = JSON.stringify(h.store.get(run.id));
    h.service.turnStarted('session-9', { model: 'claude-opus-5-5', servers: [] });
    expect(h.world.stops).toEqual([]);
    expect(JSON.stringify(h.store.get(run.id))).toBe(before);
    // Nor for a legacy agent run's session.
    const legacy = await accepted(
      `version: 1\nautomations:\n  - name: digest\n${DAILY_AUTO}    run: { prompt: Sum up api. }\n`,
    );
    const legacyRun = (await legacy.service.trigger(WORKSPACE_ID, 'digest'))!;
    await legacy.flush();
    legacy.service.turnStarted('session-1', { model: 'claude-opus-5-5', servers: [] });
    expect(legacy.world.stops).toEqual([]);
    expect(legacy.store.get(legacyRun.id)?.status).toBe('running');
  });

  it('an init whose run has lost its definition checks nothing', async () => {
    const { h, run } = await started();
    fs.rmSync(path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'definition.json'));
    h.service.turnStarted('session-1', { servers: [] });
    expect(h.world.stops).toEqual([]);
  });

  describe('checked again when the turn ends', () => {
    // The start can miss an init: a line a new CLI renamed, a terminal the
    // host could not match to its session, an init before the step's
    // session was recorded. The turn's end checks from what it reported.
    const NEVER_SAID =
      'Its turn never said which servers it loaded, so it may have run without `grafana`.';

    it('never completes a step whose servers were never checked', async () => {
      const { h, run } = await started();
      h.world.setOutputs('session-1', { mood: 'calm' });
      await h.world.endTurn('session-1', {
        exitCode: 0,
        report: turnReport({ cost: 0.01, turns: 2 }),
      });
      expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
        status: 'failed',
        error: NEVER_SAID,
        turn: { costUsd: 0.01, turns: 2 },
      });
      expect(h.world.reminders).toEqual([]);
    });

    it('nor one whose turn did not report itself at all', async () => {
      const { h, run } = await started();
      h.world.setOutputs('session-1', { mood: 'calm' });
      await h.world.endTurn('session-1', { exitCode: 0 });
      expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
        status: 'failed',
        error: NEVER_SAID,
      });
    });

    it('an init only the report carries is checked, and its words win', async () => {
      const { h, run } = await started();
      h.world.setOutputs('session-1', { mood: 'calm' });
      await h.world.endTurn('session-1', {
        exitCode: 0,
        report: {
          ...turnReport({ subtype: 'error_during_execution', isError: true, text: 'no grafana' }),
          init: { servers: [{ name: 'grafana', status: 'needs-auth' }], signInHint: HINT },
        },
      });
      expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
        status: 'failed',
        error:
          '`grafana` was not connected (needs-auth). Sign in to it in Claude (run `claude`, then /mcp), then retry this step.',
      });
    });

    it('an init only the report carries, with the server connected, completes', async () => {
      const { h, run } = await started();
      h.world.setOutputs('session-1', { mood: 'calm' });
      await h.world.endTurn('session-1', {
        exitCode: 0,
        report: {
          ...turnReport({}),
          init: { servers: [{ name: 'grafana', status: 'connected' }] },
        },
      });
      expect(h.store.get(run.id)?.steps?.[0].status).toBe('completed');
    });

    it('a turn that failed on its own before any init keeps its own words', async () => {
      const { h, run } = await started();
      await h.world.endTurn('session-1', {
        exitCode: 130,
        stopped: 'you stopped it',
        report: turnReport({ noResult: true }),
      });
      expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
        status: 'failed',
        error: 'It stopped before finishing: you stopped it.',
      });
    });
  });

  it('the words are used once', async () => {
    const { h, run } = await started();
    h.service.turnStarted('session-1', { servers: [] });
    await h.world.endTurn('session-1', { exitCode: 0, stopped: STOPPED, report: turnReport({}) });
    expect(h.store.get(run.id)?.status).toBe('failed');

    await h.service.retry(run.id);
    await h.flush();
    const init = { servers: [{ name: 'grafana', status: 'connected' }] };
    h.service.turnStarted('session-2', init);
    h.world.setOutputs('session-2', { mood: 'calm' });
    await h.world.endTurn('session-2', { exitCode: 0, report: { ...turnReport({}), init } });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({ status: 'completed', attempt: 2 });
  });
});
