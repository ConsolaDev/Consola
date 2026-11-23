import { automationVersion, parseFactorySpec } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import { NO_SECRETS } from './secrets/unbound';
import {
  BIND_HINT,
  stepsHarness,
  WORKSPACE_ID,
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
});
