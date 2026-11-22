import { describe, expect, it, vi } from 'vitest';
import {
  automationEntryText,
  automationVersion,
  factoryFilesOf,
  parseFactory,
  stepsResolvedBody,
} from '@consola/factory-spec';
import {
  factoryWith,
  RE_REVIEW_COMMAND,
  RE_REVIEW_ENTRY,
  RE_REVIEW_NAME,
  sourcesHarness,
} from './sources/sources.test-helpers';
import {
  memoryAppliedStore,
  stepsHarness,
  turnReport,
  WORKSPACE_ID,
  type StepsHarness,
  type StepsHarnessOptions,
} from './steps/steps.test-helpers';

/*
 * The factory folder applies as a unit: from its first clean apply on, a
 * read with a problem in any file keeps the last applied version running
 * (persisted, so a restart runs it too), but for the entries the read
 * removes. Until a first clean apply, entries apply one by one, as they did
 * before the folder existed.
 */

// Copied from AutomationService.agents.test.ts, where they are module-local.
const REVIEWER =
  "---\nharness: claude-work\nmodel: opus\nmax_turns: 30\n---\nYou review catalog-portal's changes.\n";
const REVIEWER_FILE = 'agents/reviewer.md';
const CATALOG_REVIEW_FILE = 'automations/catalog-review.yaml';
const CATALOG_REVIEW = `on: { cron: "0 7 * * 1-5" }
scope: catalog-portal
mode: auto
steps:
  - id: look
    agent: reviewer
    outputs:
      verdict: { enum: [ok, look-again] }
  - id: tell
    prompt: Tell the team what the review found.
    reads: [look.handover]
`;
const CLAUDE_WORK = { name: 'Claude work', problem: null };
const TURNED_OFF =
  '`claude-work` is turned off: turn it on in Settings › Harnesses, or change `harness:`';
const ENTRY_NAME = 'catalog-review';

/** The reviewer asking for write tools, with a new body: a file with a problem of its own. */
const BROKEN_REVIEWER =
  '---\nharness: claude-work\nmodel: opus\ntools: write\n---\nYou now rewrite catalog-portal.\n';
/** An agent no entry uses, broken the same way: a problem in a file the entries do not read. */
const BROKEN_DRAFTER = '---\ntools: write\n---\nYou draft.\n';
const EMPTY_YML = 'version: 1\nautomations: []\n';
const FOLDER = `/home/me/.consola/workspaces/${WORKSPACE_ID}`;
const OLD_DIGEST_FILE = 'automations/old-digest.yaml';
const OLD_DIGEST =
  'on: { cron: "0 6 * * *" }\nscope: catalog-portal\nmode: confirm\nrun: { prompt: Write the overnight digest. }\n';
const NIGHTLY_YML = `version: 1
automations:
  - name: nightly
    on: { cron: "0 9 * * 1-5" }
    scope: api
    mode: auto
    run: { prompt: Look at what changed in api overnight. }
`;
/** The two problems a broken reviewer brings: its own, and the step that names it. */
const REVIEWER_PROBLEMS = 'agents/reviewer.md and automations/catalog-review.yaml';

/** The folder these tests start from: an empty factory.yml, the entry in its own file, its agent. */
async function folder(options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  return stepsHarness({
    yaml: EMPTY_YML,
    files: { [CATALOG_REVIEW_FILE]: CATALOG_REVIEW, [REVIEWER_FILE]: REVIEWER },
    agentHarnesses: { 'claude-work': CLAUDE_WORK },
    ...options,
  });
}

/** Accept every entry of ws-1's folder at the version its files give it (no actions here). */
function acceptAll(h: StepsHarness): void {
  const read = parseFactory(factoryFilesOf(Object.fromEntries(h.texts())));
  for (const automation of read.automations) {
    const hashes: Record<string, string> = {};
    for (const step of automation.steps ?? [])
      if (step.kind === 'agent' && step.agent !== undefined)
        hashes[step.agent] = read.agents[step.agent].hash;
    h.store.accept(
      `${WORKSPACE_ID} ${automation.name}`,
      automationVersion(automation, stepsResolvedBody({}, hashes)),
    );
  }
}

const standing = (h: StepsHarness) => h.service.snapshot(WORKSPACE_ID).standing;
const names = (h: StepsHarness) => h.service.list(WORKSPACE_ID).map((view) => view.name);
const viewOf = (h: StepsHarness, name = ENTRY_NAME) =>
  h.service.list(WORKSPACE_ID).find((view) => view.name === name);

/** Run catalog-review now, as an accepted `auto` entry does, and let its first step launch. */
async function runNow(h: StepsHarness) {
  const run = (await h.service.trigger(WORKSPACE_ID, ENTRY_NAME))!;
  await h.flush();
  return run;
}

describe('the first clean apply', () => {
  it('a clean folder applies, and is kept', async () => {
    const h = await folder();
    const record = h.appliedStore.records.get(FOLDER);
    expect(record).toMatchObject({
      folder: FOLDER,
      clean: true,
      appliedAt: h.now().toISOString(),
    });
    expect(record?.texts).toEqual({
      'factory.yml': EMPTY_YML,
      [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
      [REVIEWER_FILE]: REVIEWER,
    });
    // B1: the first clean read switches the unit rule on.
    expect(standing(h)).toBeUndefined();
    await h.writeFile(OLD_DIGEST_FILE, OLD_DIGEST.replace('mode: confirm', 'mode: sometimes'));
    expect(standing(h)).toBeDefined();
    expect(names(h)).toEqual([ENTRY_NAME]);
  });

  it('a workspace with no applied version applies its valid entries, as today', async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        [REVIEWER_FILE]: REVIEWER,
        [OLD_DIGEST_FILE]: OLD_DIGEST.replace('mode: confirm', 'mode: sometimes'),
      },
    });
    expect(names(h)).toEqual([ENTRY_NAME]);
    expect(h.service.snapshot(WORKSPACE_ID).issues).toContainEqual(
      expect.objectContaining({ file: OLD_DIGEST_FILE, automation: 'old-digest' }),
    );
    expect(standing(h)).toBeUndefined();
    // What applied, one by one: the good entry's own file and its agent, not the broken one's.
    expect(h.appliedStore.records.get(FOLDER)).toMatchObject({
      clean: false,
      texts: { [CATALOG_REVIEW_FILE]: CATALOG_REVIEW, [REVIEWER_FILE]: REVIEWER },
    });
    expect(Object.keys(h.appliedStore.records.get(FOLDER)!.texts).sort()).toEqual([
      REVIEWER_FILE,
      CATALOG_REVIEW_FILE,
    ]);

    await h.writeFile(OLD_DIGEST_FILE, OLD_DIGEST);
    expect(names(h)).toEqual([ENTRY_NAME, 'old-digest']);
    expect(h.appliedStore.records.get(FOLDER)).toMatchObject({ clean: true });
    expect(Object.keys(h.appliedStore.records.get(FOLDER)!.texts).sort()).toEqual([
      REVIEWER_FILE,
      CATALOG_REVIEW_FILE,
      OLD_DIGEST_FILE,
      'factory.yml',
    ]);
    // From that read on, a new issue keeps this version running.
    await h.writeFile(OLD_DIGEST_FILE, OLD_DIGEST.replace('mode: confirm', 'mode: sometimes'));
    expect(standing(h)).toBeDefined();
    expect(names(h)).toEqual([ENTRY_NAME, 'old-digest']);
  });

  it('a damaged applied version reads as none', async () => {
    const damaged = memoryAppliedStore();
    damaged.damaged = true;
    const broken = await folder({
      appliedStore: damaged,
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        [REVIEWER_FILE]: REVIEWER,
        [OLD_DIGEST_FILE]: OLD_DIGEST.replace('mode: confirm', 'mode: sometimes'),
      },
    });
    // As a first start: the good entry runs, the bad one is an issue, nothing stands.
    expect(names(broken)).toEqual([ENTRY_NAME]);
    expect(standing(broken)).toBeUndefined();

    const clean = memoryAppliedStore();
    clean.damaged = true;
    await folder({ appliedStore: clean });
    expect(clean.records.get(FOLDER)).toMatchObject({ clean: true });
  });

  it('a store that cannot be read or written stops nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = memoryAppliedStore();
    failing.readThrows = new Error('EACCES: permission denied');
    failing.writeThrows = new Error('ENOSPC: no space left on device');
    const h = await folder({ appliedStore: failing });
    // Read as none, so a first start; what applied runs although it could not be kept.
    expect(names(h)).toEqual([ENTRY_NAME]);
    expect(failing.writes).toBe(1);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("a first start's version that later applies cleanly keeps its time", async () => {
    const start = new Date(2026, 10, 16, 8, 0);
    const h = await folder({
      yaml: NIGHTLY_YML,
      agentHarnesses: { 'claude-work': { ...CLAUDE_WORK, agentProblem: TURNED_OFF } },
    });
    // A host problem on a first start: entry by entry, but every text is in use.
    expect(h.appliedStore.records.get(FOLDER)).toMatchObject({
      clean: false,
      appliedAt: start.toISOString(),
    });
    h.advance(60 * 60 * 1000);
    h.world.agentHarnesses['claude-work'] = CLAUDE_WORK;
    await h.service.syncWorkspaces();
    expect(h.appliedStore.records.get(FOLDER)).toMatchObject({
      clean: true,
      appliedAt: start.toISOString(),
    });
  });
});

describe('a read with a problem keeps the last applied version running', () => {
  it('an issue in any file keeps the last applied version running', async () => {
    const h = await folder();
    acceptAll(h);
    const first = await runNow(h);
    await h.world.endTurn('session-1', { exitCode: 1, report: turnReport({ isError: true }) });
    expect(h.store.get(first.id)?.status).toBe('failed');

    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    expect(standing(h)?.message).toBe(
      `Your changes didn't apply: 2 problems in ${REVIEWER_PROBLEMS}. The version from 08:00 keeps running.`,
    );
    expect(h.service.snapshot(WORKSPACE_ID).issues).toContainEqual(
      expect.objectContaining({ file: REVIEWER_FILE, path: 'tools', line: 4 }),
    );
    const view = viewOf(h)!;
    expect(view.problem).toBeUndefined();
    expect(view.asksFirst).toBeUndefined();
    await runNow(h);
    expect(h.world.launches).toHaveLength(2);
    expect(h.world.launches[1].prompt).toContain("You review catalog-portal's changes.");
    expect(h.world.launches[1].prompt).not.toContain('rewrite');
  });

  it('the last applied version survives a restart', async () => {
    const h = await folder();
    acceptAll(h);
    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    const next = await h.relaunch();
    expect(standing(next)).toBeDefined();
    expect(viewOf(next)?.problem).toBeUndefined();
    await runNow(next);
    expect(next.world.launches).toHaveLength(1);
    expect(next.world.launches[0].prompt).toContain("You review catalog-portal's changes.");
  });

  it('a fix applies on the next check', async () => {
    const h = await folder();
    acceptAll(h);
    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    expect(standing(h)).toBeDefined();
    // Fixed, with a new body, while nothing watched: Check again reads it.
    h.texts().set(REVIEWER_FILE, REVIEWER.replace('You review', 'You carefully review'));
    await h.service.recheck(WORKSPACE_ID);
    expect(standing(h)).toBeUndefined();
    // A good edit asks again.
    expect(viewOf(h)?.asksFirst).toBe(true);
    const asked = await runNow(h);
    await h.service.approve(asked.id);
    await h.flush();
    expect(h.world.launches[0].prompt).toContain("You carefully review catalog-portal's changes.");
  });

  it('a read that does not parse, then the good read, stops nothing', async () => {
    const h = await folder();
    acceptAll(h);
    await h.writeFile('factory.yml', 'version: 1\nautomations:\n  - name: catalog-revi');
    expect(names(h)).toEqual([ENTRY_NAME]);
    expect(viewOf(h)?.asksFirst).toBeUndefined();
    expect(standing(h)?.removed).toEqual([]);
    await h.writeFile('factory.yml', EMPTY_YML);
    expect(standing(h)).toBeUndefined();
    expect(viewOf(h)?.asksFirst).toBeUndefined();
  });

  it('the applied version is read once', async () => {
    const h = await folder();
    expect(h.appliedStore.reads).toBe(1);
    const writes = h.appliedStore.writes;
    for (let index = 0; index < 10; index++) await h.service.syncWorkspaces();
    expect(h.appliedStore.reads).toBe(1);
    expect(h.appliedStore.writes).toBe(writes);
    // A re-check that changes nothing writes nothing either, and reads the files only.
    await h.service.recheck(WORKSPACE_ID);
    expect(h.appliedStore.writes).toBe(writes);
    expect(h.appliedStore.reads).toBe(1);
  });

  it('a workspace write before the first read decides nothing, and keeps nothing', async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        [REVIEWER_FILE]: BROKEN_REVIEWER,
        [OLD_DIGEST_FILE]: OLD_DIGEST,
      },
    });
    expect(names(h)).toEqual(['old-digest']);
    // The workspace leaves and comes back: its folder is read again, from no applied version.
    h.world.workspaceDeleted = true;
    await h.service.syncWorkspaces();
    h.world.workspaceDeleted = false;
    let release!: () => void;
    h.world.folderReadGate = new Promise((resolve) => (release = resolve));
    const adding = h.service.syncWorkspaces();
    // A session click while its folder is still being read.
    await h.service.syncWorkspaces();
    expect(h.appliedStore.records.has(FOLDER)).toBe(false);
    release();
    h.world.folderReadGate = undefined;
    await adding;
    expect(names(h)).toEqual(['old-digest']);
    expect(standing(h)).toBeUndefined();
  });

  it("the banner's time is worded when the snapshot is built", async () => {
    const h = await folder({ now: new Date(2026, 10, 22, 10, 42) });
    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    expect(standing(h)?.message).toBe(
      `Your changes didn't apply: 2 problems in ${REVIEWER_PROBLEMS}. The version from 10:42 keeps running.`,
    );
    h.advance(24 * 60 * 60 * 1000);
    expect(standing(h)?.message).toBe(
      `Your changes didn't apply: 2 problems in ${REVIEWER_PROBLEMS}. The version from 22 Nov 10:42 keeps running.`,
    );
    expect(standing(h)?.appliedAt).toBe(new Date(2026, 10, 22, 10, 42).toISOString());
  });
});

describe('a removal always applies', () => {
  it('a removal applies while another file is broken', async () => {
    const h = await folder({
      maxConcurrentAgents: 0,
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        [REVIEWER_FILE]: REVIEWER,
        [OLD_DIGEST_FILE]: OLD_DIGEST,
      },
    });
    const digestSchedule = `${WORKSPACE_ID} old-digest 0 6 * * *`;
    const asked = (await h.service.trigger(WORKSPACE_ID, 'old-digest'))!;
    await h.service.approve(asked.id);
    expect(h.store.get(asked.id)?.status).toBe('queued');
    expect(h.store.lastFired(digestSchedule)).toBeDefined();

    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    expect(standing(h)?.removed).toEqual([]);
    const kept = structuredClone(h.appliedStore.records.get(FOLDER));
    await h.writeFile(OLD_DIGEST_FILE, null);
    expect(names(h)).toEqual([ENTRY_NAME]);
    expect(standing(h)?.removed).toEqual(['old-digest']);
    expect(standing(h)?.message).toMatch(
      /^`old-digest` was removed\. The rest of your changes didn't apply: /,
    );
    expect(h.store.lastFired(digestSchedule)).toBeUndefined();
    // Nothing is persisted while the folder does not apply: no list of removals.
    expect(h.appliedStore.records.get(FOLDER)).toEqual(kept);

    h.world.maxConcurrentAgents = undefined;
    await h.tick();
    expect(h.store.get(asked.id)).toMatchObject({
      status: 'rejected',
      summary: 'It is no longer in its workspace’s factory.',
    });

    // Its file is still gone at the next start's read: still removed.
    const next = await h.relaunch();
    expect(names(next)).toEqual([ENTRY_NAME]);
    expect(standing(next)?.removed).toEqual(['old-digest']);
  });

  it('an entry missing from a factory.yml that no longer parses is not removed', async () => {
    const h = await folder({ yaml: NIGHTLY_YML });
    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    await h.writeFile('factory.yml', 'version: 1\nautomations: [\n');
    expect(names(h)).toEqual(['nightly', ENTRY_NAME]);
    expect(standing(h)?.removed).toEqual([]);
  });

  it('a file missing for one read comes back', async () => {
    const h = await folder({ yaml: NIGHTLY_YML });
    acceptAll(h);
    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    await h.writeFile('factory.yml', null);
    expect(names(h)).toEqual([ENTRY_NAME]);
    expect(standing(h)?.message).toMatch(/^`nightly` was removed\./);
    await h.writeFile('factory.yml', NIGHTLY_YML);
    expect(names(h)).toEqual(['nightly', ENTRY_NAME]);
    expect(viewOf(h, 'nightly')?.asksFirst).toBeUndefined();
    expect(standing(h)?.removed).toEqual([]);
    expect(standing(h)?.message).toMatch(/^Your changes didn't apply: /);
  });
});

describe('machine checks', () => {
  it('a machine check blocks a changed entry and is a per-entry problem for an unchanged one', async () => {
    const h = await folder();
    h.world.agentHarnesses['claude-work'] = { ...CLAUDE_WORK, agentProblem: TURNED_OFF };
    await h.service.syncWorkspaces();
    expect(viewOf(h)?.problem).toBe(`agents/reviewer.md: ${TURNED_OFF}`);
    expect(standing(h)).toBeUndefined();
    await expect(h.service.trigger(WORKSPACE_ID, ENTRY_NAME)).rejects.toThrow(/cannot run/);
    expect(h.world.launches).toEqual([]);

    const edited = CATALOG_REVIEW.replace('Tell the team', 'Tell alice');
    await h.writeFile(CATALOG_REVIEW_FILE, edited);
    expect(standing(h)?.message).toBe(
      "Your changes didn't apply: 1 problem in agents/reviewer.md. The version from 08:00 keeps running.",
    );
    // What keeps it from applying is listed with the rest: at the agent file's `harness:` line.
    expect(h.service.snapshot(WORKSPACE_ID).issues).toEqual([
      {
        message: `agents/reviewer.md: ${TURNED_OFF}`,
        file: REVIEWER_FILE,
        line: 2,
        path: 'harness',
        automation: ENTRY_NAME,
      },
    ]);
    // The old `tell` prompt is the one that runs.
    expect(await h.service.entryText(WORKSPACE_ID, ENTRY_NAME)).toBe(CATALOG_REVIEW);

    h.world.agentHarnesses['claude-work'] = CLAUDE_WORK;
    await h.service.syncWorkspaces();
    expect(standing(h)).toBeUndefined();
    expect(await h.service.entryText(WORKSPACE_ID, ENTRY_NAME)).toBe(edited);
    expect(viewOf(h)?.problem).toBeUndefined();
  });

  it('a re-check that changes only what keeps the folder from applying still tells the windows', async () => {
    const writer = (harness: string) => `---\nharness: ${harness}\n---\nYou write the notes.\n`;
    const notes = (agent: string) =>
      `on: { cron: "0 8 * * 1-5" }\nscope: catalog-portal\nsteps:\n  - id: write\n    agent: ${agent}\n`;
    const h = await folder({
      agentHarnesses: {
        'claude-work': CLAUDE_WORK,
        'claude-a': { name: 'Claude A', problem: null, agentProblem: 'A is off' },
        'claude-b': { name: 'Claude B', problem: null, agentProblem: 'B is off' },
      },
    });
    await h.writeFile('agents/writer-a.md', writer('claude-a'));
    await h.writeFile('agents/writer-b.md', writer('claude-b'));
    await h.writeFile('automations/notes-a.yaml', notes('writer-a'));
    await h.writeFile('automations/notes-b.yaml', notes('writer-b'));
    expect(h.service.snapshot(WORKSPACE_ID).issues).toHaveLength(2);
    const listed = JSON.stringify(h.service.list(WORKSPACE_ID));
    const broadcasts = h.world.broadcasts.length;
    h.world.agentHarnesses['claude-a'] = { name: 'Claude A', problem: null };
    await h.service.syncWorkspaces();
    expect(standing(h)).toBeDefined();
    expect(h.service.snapshot(WORKSPACE_ID).issues).toHaveLength(1);
    expect(JSON.stringify(h.service.list(WORKSPACE_ID))).toBe(listed);
    expect(h.world.broadcasts.length).toBeGreaterThan(broadcasts);
  });

  it('a cron-only edit is not a change', async () => {
    const h = await folder();
    h.world.agentHarnesses['claude-work'] = { ...CLAUDE_WORK, agentProblem: TURNED_OFF };
    await h.service.syncWorkspaces();
    const moved = CATALOG_REVIEW.replace('0 7 * * 1-5', '0 8 * * 1-5');
    await h.writeFile(CATALOG_REVIEW_FILE, moved);
    expect(standing(h)).toBeUndefined();
    expect(viewOf(h)).toMatchObject({ schedule: '0 8 * * 1-5' });
    expect(viewOf(h)?.problem).toBe(`agents/reviewer.md: ${TURNED_OFF}`);
    expect(h.appliedStore.records.get(FOLDER)?.texts[CATALOG_REVIEW_FILE]).toBe(moved);
  });
});

describe('the entry as written is the version that runs', () => {
  it('the entry as written is the version that runs', async () => {
    const h = await sourcesHarness({
      yaml: factoryWith(RE_REVIEW_ENTRY),
      files: { [REVIEWER_FILE]: REVIEWER },
      agentHarnesses: { 'claude-work': CLAUDE_WORK },
    });
    const applied = h.texts().get('factory.yml')!;
    const before = h.service.list(WORKSPACE_ID)[0];
    expect(before).toMatchObject({ name: RE_REVIEW_NAME, needsAllow: true });

    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    const editedCommand = RE_REVIEW_COMMAND.replace(
      "gh api graphql -f query='",
      "gh api graphql --paginate -f query='",
    );
    const edited = applied.replace(RE_REVIEW_COMMAND.split('\n')[0], editedCommand.split('\n')[0]);
    expect(edited).not.toBe(applied);
    await h.setYaml(edited);
    expect(h.service.snapshot(WORKSPACE_ID).standing).toBeDefined();
    expect(await h.service.entryText(WORKSPACE_ID, RE_REVIEW_NAME)).toBe(
      automationEntryText(applied, RE_REVIEW_NAME),
    );
    const shown = h.service.list(WORKSPACE_ID)[0];
    expect(shown.version).toBe(before.version);
    // Allow accepts exactly what the person read, and it checks with that command.
    h.service.allow(WORKSPACE_ID, RE_REVIEW_NAME, shown.version!);
    await h.check();
    const checks = h.world.commands.filter((command) => command.spec.command.includes('graphql'));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[checks.length - 1].spec.command).toBe(RE_REVIEW_COMMAND);

    await h.writeFile(REVIEWER_FILE, REVIEWER);
    expect(h.service.snapshot(WORKSPACE_ID).standing).toBeUndefined();
    expect(await h.service.entryText(WORKSPACE_ID, RE_REVIEW_NAME)).toBe(
      automationEntryText(edited, RE_REVIEW_NAME),
    );
    const after = h.service.list(WORKSPACE_ID)[0];
    expect(after.version).not.toBe(before.version);
    expect(after.needsAllow).toBe(true);
  });
});

describe('saving while the folder does not apply', () => {
  const NOTES =
    '- name: catalog-notes\n  on: { cron: "0 8 * * 1-5" }\n  scope: catalog-portal\n  run: { prompt: Write the catalog notes. }';

  it('saving while the folder does not apply says so', async () => {
    const h = await folder();
    await h.writeFile(REVIEWER_FILE, BROKEN_REVIEWER);
    const saved = await h.service.saveEntry(WORKSPACE_ID, NOTES, { replace: false });
    expect(saved.notApplied).toEqual({
      issues: [
        'agents/reviewer.md:4: Write tools arrive with write steps; an agent is read-only until then',
        'automations/catalog-review.yaml:6: `reviewer` has problems of its own in agents/reviewer.md; this step runs once they are fixed',
      ],
      since: '08:00',
    });
    expect(names(h)).not.toContain('catalog-notes');
    // A save into a folder that applies says nothing of it.
    await h.writeFile(REVIEWER_FILE, REVIEWER);
    const again = await h.service.saveEntry(WORKSPACE_ID, NOTES, { replace: true });
    expect(again).not.toHaveProperty('notApplied');
  });

  it("an agent's addition survives while the folder does not apply", async () => {
    const h = await folder();
    h.world.agentHarnesses['claude-work'] = { ...CLAUDE_WORK, agentProblem: TURNED_OFF };
    await h.service.syncWorkspaces();
    await h.writeFile(CATALOG_REVIEW_FILE, CATALOG_REVIEW.replace('Tell the team', 'Tell alice'));
    expect(standing(h)).toBeDefined();
    await h.service.saveEntry(WORKSPACE_ID, NOTES, {
      replace: false,
      by: { sessionId: 's-9', sessionName: 'Catalog helper' },
    });
    expect(names(h)).not.toContain('catalog-notes');

    h.world.agentHarnesses['claude-work'] = CLAUDE_WORK;
    await h.service.syncWorkspaces();
    expect(standing(h)).toBeUndefined();
    expect(viewOf(h, 'catalog-notes')?.addedBy).toEqual({
      sessionId: 's-9',
      sessionName: 'Catalog helper',
      isNew: true,
    });
    // An entry that applied at a re-check starts its schedule then.
    expect(h.store.lastFired(`${WORKSPACE_ID} catalog-notes 0 8 * * 1-5`)).toBe(
      h.now().toISOString(),
    );
  });

  it('a replace while the folder does not apply revokes the running acceptance too', async () => {
    const h = await folder();
    acceptAll(h);
    // A problem in a file the entry does not read: its replacement still resolves.
    await h.writeFile('agents/drafter.md', BROKEN_DRAFTER);
    expect(standing(h)).toBeDefined();
    expect(viewOf(h)?.asksFirst).toBeUndefined();
    const item = `- name: ${ENTRY_NAME}\n  ${CATALOG_REVIEW.trimEnd().replace(/\n/g, '\n  ')}`;
    const saved = await h.service.saveEntry(
      WORKSPACE_ID,
      item.replace('Tell the team', 'Tell bob'),
      {
        replace: true,
      },
    );
    expect(saved.notApplied).toBeDefined();
    // Nothing it wrote is running: no line of the running version's, no Allow it waits for.
    expect(saved).not.toHaveProperty('line');
    expect(saved).not.toHaveProperty('needsAllow');
    // The running version asks before its next unattended run.
    expect(viewOf(h)?.asksFirst).toBe(true);
  });
});

describe('a deleted workspace', () => {
  it('a deleted workspace forgets its applied version', async () => {
    const h = await folder();
    expect(h.appliedStore.records.has(FOLDER)).toBe(true);
    h.world.workspaceDeleted = true;
    await h.service.syncWorkspaces();
    expect(h.appliedStore.forgotten).toEqual([FOLDER]);
    expect(h.appliedStore.records.has(FOLDER)).toBe(false);
  });
});
