import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { factoryFilesOf, parseFactory } from '@consola/factory-spec';
import { inboxItem } from './inboxItems.test-helpers';
import { factoryWith, sourcesHarness } from './sources/sources.test-helpers';
import { skillFilesOf, stepsHarness, turnReport, WORKSPACE_ID } from './steps/steps.test-helpers';
import type { StepsHarness, StepsHarnessOptions } from './steps/steps.test-helpers';

/*
 * A run's own copy of the skills its steps' agents name (2-C): written into
 * its folder when it fires, from the running version; re-hashed against its
 * definition before each attempt launches, so a retry days later delivers
 * what was approved, whatever the folder or the run folder holds now. And
 * whose checkout each run works in, which its definition records.
 */

const INVESTIGATE_FILE = 'automations/investigate.yaml';
const INVESTIGATE = `on: { cron: "0 9 * * 1-5" }
scope: api
mode: auto
steps:
  - id: investigate
    agent: investigator
`;
const INVESTIGATOR_FILE = 'agents/investigator.md';
const INVESTIGATOR =
  "---\nharness: claude-work\nskills: [incident-triage]\n---\nYou look into the night's alerts.\n";
const TRIAGE_MD =
  "---\nname: incident-triage\ndescription: The team's triage checklist.\n---\nCheck the alert first.\n";
const QUERIES = 'Use rate() over five minutes.\n';
const SKILL_FILES = {
  'skills/incident-triage/SKILL.md': TRIAGE_MD,
  'skills/incident-triage/queries.md': QUERIES,
};
const MISMATCH =
  'Its skills in the run folder are not the ones its version holds (skills/incident-triage), so it did not start: run the automation again.';

async function investigating(options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  return stepsHarness({
    files: {
      [INVESTIGATE_FILE]: INVESTIGATE,
      [INVESTIGATOR_FILE]: INVESTIGATOR,
      ...SKILL_FILES,
    },
    agentHarnesses: { 'claude-work': { name: 'Work stub', problem: null } },
    ...options,
  });
}

/** Run now, approved once, and let its first step launch. */
async function runNow(h: StepsHarness, name = 'investigate') {
  const asked = (await h.service.trigger(WORKSPACE_ID, name))!;
  expect(asked.status).toBe('needs-approval');
  await h.service.approve(asked.id);
  await h.flush();
  return h.store.get(asked.id)!;
}

/** The skill's hash in ws-1's folder as it reads now. */
const hashNow = (h: StepsHarness) =>
  parseFactory(factoryFilesOf(Object.fromEntries(h.texts()), skillFilesOf(h.texts()))).skills[
    'incident-triage'
  ].hash;

const decoded = (files: Array<{ path: string; bytes: Uint8Array }> | null | undefined) =>
  files?.map((file) => [file.path, new TextDecoder().decode(file.bytes)]);

describe("a run's own copy of its skills", () => {
  it('a fired run records the skill and its checkout, holds the files, and launches with both dirs', async () => {
    const h = await investigating();
    const hash = hashNow(h);
    const run = await runNow(h);
    const definition = h.service.getRunDefinition(run.id)!;
    expect(definition.skills).toEqual({ 'incident-triage': hash });
    expect(definition.checkout).toBe('scope');
    // A schedule's runs carry no item.
    expect(Object.prototype.hasOwnProperty.call(definition, 'readsItems')).toBe(false);

    // On disk, in the run's folder.
    expect(
      fs.readdirSync(path.join(h.folder.skillsDir(WORKSPACE_ID, run.id), 'incident-triage')).sort(),
    ).toEqual(['SKILL.md', 'queries.md']);
    expect(
      decoded(h.folder.readSkills(WORKSPACE_ID, run.id, ['incident-triage'])['incident-triage']),
    ).toEqual([
      ['SKILL.md', TRIAGE_MD],
      ['queries.md', QUERIES],
    ]);

    expect(h.world.launches).toHaveLength(1);
    const { step } = h.world.launches[0];
    expect(step?.checkout).toBe('scope');
    expect(step?.agent?.skillsDir).toBe(h.folder.skillsDir(WORKSPACE_ID, run.id));
    // What the host checks the plugin it builds, and every later launch, against (review M1).
    expect(step?.agent?.skillHashes).toStrictEqual({ 'incident-triage': hash });
    expect(step?.pluginDir).toBe(
      `${h.folder.attemptDir(WORKSPACE_ID, run.id, 'investigate', 1)}/plugin`,
    );
    expect(step?.pluginDir?.endsWith('/investigate/1/plugin')).toBe(true);
  });

  it("the folder's skill edited and applied after the fire: a retry still launches on the copy it fired with", async () => {
    const h = await investigating();
    const run = await runNow(h);
    const copy = h.folder.readSkills(WORKSPACE_ID, run.id, ['incident-triage']);
    await h.writeFile('skills/incident-triage/queries.md', 'Use rate() over one minute.\n');
    // It applied: the entry's version moved with its agent's skill.
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBe(true);
    await h.world.endTurn('session-1', { exitCode: 1, report: turnReport({ isError: true }) });
    expect(h.store.get(run.id)?.status).toBe('failed');

    await h.service.retry(run.id, 'investigate');
    await h.flush();
    expect(h.world.launches).toHaveLength(2);
    expect(h.world.launches[1].step?.pluginDir).toBe(
      `${h.folder.attemptDir(WORKSPACE_ID, run.id, 'investigate', 2)}/plugin`,
    );
    expect(h.folder.readSkills(WORKSPACE_ID, run.id, ['incident-triage'])).toEqual(copy);
  });

  it('a copy changed in the run folder fails the step, and its retry, with nothing launched', async () => {
    const h = await investigating();
    const run = await runNow(h);
    await h.world.endTurn('session-1', { exitCode: 1, report: turnReport({ isError: true }) });
    h.corruptSkill(WORKSPACE_ID, run.id, 'incident-triage');
    const launches = h.world.launches.length;

    await h.service.retry(run.id, 'investigate');
    await h.flush();
    expect(h.world.launches).toHaveLength(launches);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed' });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      id: 'investigate',
      status: 'failed',
      attempt: 2,
      error: MISMATCH,
    });

    await h.service.retry(run.id, 'investigate');
    await h.flush();
    expect(h.world.launches).toHaveLength(launches);
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      attempt: 3,
      error: MISMATCH,
    });
  });

  it('a copy gone from the run folder fails the step the same way', async () => {
    const h = await investigating();
    const run = await runNow(h);
    await h.world.endTurn('session-1', { exitCode: 1, report: turnReport({ isError: true }) });
    fs.rmSync(path.join(h.folder.skillsDir(WORKSPACE_ID, run.id), 'incident-triage'), {
      recursive: true,
    });
    await h.service.retry(run.id, 'investigate');
    await h.flush();
    expect(h.world.launches).toHaveLength(1);
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({ status: 'failed', error: MISMATCH });
  });

  it('a definition that records no hash for a skill its agent names fails the step the same way', async () => {
    const h = await investigating();
    const run = await runNow(h);
    await h.world.endTurn('session-1', { exitCode: 1, report: turnReport({ isError: true }) });
    // As a definition written before skills were copied would read: the copy is there, its hash is not.
    const { skills: _skills, ...older } = h.folder.readDefinition(WORKSPACE_ID, run.id)!;
    h.folder.writeDefinition(WORKSPACE_ID, run.id, older);
    await h.service.retry(run.id, 'investigate');
    await h.flush();
    expect(h.world.launches).toHaveLength(1);
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({ status: 'failed', error: MISMATCH });
  });

  it('a copy that cannot be read fails the step, saying why', async () => {
    const h = await investigating();
    const run = await runNow(h);
    await h.world.endTurn('session-1', { exitCode: 1, report: turnReport({ isError: true }) });
    vi.spyOn(h.folder, 'readSkills').mockImplementation(() => {
      throw new Error('EIO: i/o error');
    });
    await h.service.retry(run.id, 'investigate');
    await h.flush();
    expect(h.world.launches).toHaveLength(1);
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({
      status: 'failed',
      error:
        'Its skills could not be read from the run folder (EIO: i/o error), so it did not start: run the automation again.',
    });
  });

  it('skills that cannot be written fail the run as it fires', async () => {
    const h = await investigating();
    vi.spyOn(h.folder, 'writeSkills').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const asked = (await h.service.trigger(WORKSPACE_ID, 'investigate'))!;
    expect(asked).toMatchObject({
      status: 'failed',
      error: 'Could not write its skills: EACCES: permission denied.',
    });
    expect(h.world.launches).toEqual([]);
  });

  it('a run fired while the folder does not apply copies the skill as the running version holds it', async () => {
    const h = await investigating({ yaml: 'version: 1\nautomations: []\n' });
    // A skill edited and the agent broken, in one read: the applied version keeps running.
    h.texts().set('skills/incident-triage/queries.md', 'Use rate() over one minute.\n');
    h.texts().set(INVESTIGATOR_FILE, INVESTIGATOR.replace('---\nYou', 'tools: write\n---\nYou'));
    await h.service.reload(WORKSPACE_ID);
    expect(h.service.snapshot(WORKSPACE_ID).standing).toBeDefined();
    const asked = (await h.service.trigger(WORKSPACE_ID, 'investigate'))!;
    expect(
      decoded(h.folder.readSkills(WORKSPACE_ID, asked.id, ['incident-triage'])['incident-triage']),
    ).toEqual([
      ['SKILL.md', TRIAGE_MD],
      ['queries.md', QUERIES],
    ]);
  });

  it('an entry whose agent names no skill writes none, and its definition has no skills key', async () => {
    const h = await investigating({
      files: {
        [INVESTIGATE_FILE]: INVESTIGATE,
        [INVESTIGATOR_FILE]: INVESTIGATOR.replace('skills: [incident-triage]\n', ''),
        ...SKILL_FILES,
      },
    });
    const run = await runNow(h);
    const definition = h.service.getRunDefinition(run.id)!;
    expect(Object.prototype.hasOwnProperty.call(definition, 'skills')).toBe(false);
    expect(definition.checkout).toBe('scope');
    expect(fs.existsSync(h.folder.skillsDir(WORKSPACE_ID, run.id))).toBe(false);
    const { step } = h.world.launches[0];
    expect(Object.prototype.hasOwnProperty.call(step, 'pluginDir')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(step?.agent, 'skillsDir')).toBe(false);
  });
});

describe("a run's checkout kind", () => {
  it("an event entry's run works in the item's checkout and reads text other people wrote", async () => {
    const yaml = factoryWith(`- name: look-at-reviews
  on: { github: { events: [pull_request.review_requested] } }
  mode: confirm
  steps:
    - id: look
      prompt: Look at {{item.url}}.
`);
    const h = await stepsHarness({ yaml });
    await h.poll([]);
    await h.poll([inboxItem({ repo: 'sprocket/catalog-portal', number: 51 })]);
    const [run] = h.store.runs();
    expect(run.status).toBe('needs-approval');
    const definition = h.service.getRunDefinition(run.id)!;
    expect(definition.checkout).toBe('item');
    expect(definition.readsItems).toBe(true);
    await h.service.approve(run.id);
    await h.flush();
    expect(h.world.launches).toHaveLength(1);
    expect(h.world.launches[0].step?.checkout).toBe('item');
  });

  it("a poll with key: and scope: works in its scope's folder, and reads text other people wrote", async () => {
    const h = await sourcesHarness({
      yaml: factoryWith(`- name: tickets
  on:
    poll: { every: 1h, run: ./tickets, key: .id }
  scope: api
  mode: confirm
  steps:
    - id: look
      prompt: Look at the ticket.
`),
    });
    const shown = h.service.list(WORKSPACE_ID)[0];
    h.service.allow(WORKSPACE_ID, 'tickets', shown.version!);
    h.pollOutput([{ id: 'T-1', title: 'The cart forgets its items' }]);
    await h.check();
    const run = await h.runOn({ key: 'T-1' }, 'tickets');
    expect(run.status).toBe('needs-approval');
    const definition = h.service.getRunDefinition(run.id)!;
    expect(definition.checkout).toBe('scope');
    expect(definition.readsItems).toBe(true);
  });
});
