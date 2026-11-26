import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryAppliedStore, stepsHarness, WORKSPACE_ID } from './steps/steps.test-helpers';

/*
 * A folder that cannot be read, or a file that cannot be parsed, is an issue
 * of that folder; it never stops the service starting, nor another
 * workspace's folder, nor a reload from the watcher (the review's S1: one
 * YAML file with many aliases used to make `parseFactory` throw, and then no
 * automation in any workspace ticked).
 */

const parseThrows = vi.hoisted(() => ({ on: false }));
vi.mock('@consola/factory-spec', async (original) => {
  const actual = await original<typeof import('@consola/factory-spec')>();
  return {
    ...actual,
    parseFactory: (files: Parameters<typeof actual.parseFactory>[0]) => {
      if (parseThrows.on || files.factoryYml?.includes('# parse-throws')) {
        throw new Error('the parser fell over\nat line 7');
      }
      return actual.parseFactory(files);
    },
  };
});
afterEach(() => {
  parseThrows.on = false;
  vi.restoreAllMocks();
});

const NIGHTLY = `version: 1
automations:
  - name: nightly
    on: { cron: "0 9 * * 1-5" }
    scope: api
    mode: auto
    run: { prompt: Look at what changed in api overnight. }
`;
const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
for (let index = 0; index < 150; index++) lines.push(`b${index}: *a`);
const ALIASED = `---\n${lines.join('\n')}\n---\nbody\n`;
const TOO_MANY =
  'This file uses YAML aliases (`*name`) more than Consola reads: write the values out.';

const names = (h: Awaited<ReturnType<typeof stepsHarness>>) =>
  h.service.list(WORKSPACE_ID).map((view) => view.name);

describe('a folder that cannot be read whole', () => {
  it('an agent file with many YAML aliases is its own issue, and the good entry runs', async () => {
    const h = await stepsHarness({ yaml: NIGHTLY, files: { 'agents/x.md': ALIASED } });
    expect(names(h)).toEqual(['nightly']);
    expect(h.service.snapshot(WORKSPACE_ID).issues).toEqual([
      { file: 'agents/x.md', path: '', line: 2, message: TOO_MANY },
    ]);
  });

  it('a parse that throws is one issue of the folder, and the start goes on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    parseThrows.on = true;
    const h = await stepsHarness({ yaml: NIGHTLY });
    expect(names(h)).toEqual([]);
    expect(h.service.snapshot(WORKSPACE_ID).issues).toEqual([
      {
        message: "Could not read this factory's folder: the parser fell over.",
        file: 'factory.yml',
        path: '',
      },
    ]);
    // Once it parses again, it applies.
    parseThrows.on = false;
    await h.service.recheck(WORKSPACE_ID);
    expect(names(h)).toEqual(['nightly']);
  });

  it('a read that throws keeps what applied running, and removes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await stepsHarness({ yaml: NIGHTLY });
    expect(names(h)).toEqual(['nightly']);
    h.world.folderReadThrows = new Error('EIO: i/o error, read');
    await h.service.recheck(WORKSPACE_ID);
    expect(names(h)).toEqual(['nightly']);
    const snapshot = h.service.snapshot(WORKSPACE_ID);
    expect(snapshot.standing).toBeDefined();
    expect(snapshot.issues.map((issue) => issue.message)).toEqual([
      "Could not read this factory's folder: EIO: i/o error, read.",
    ]);
  });

  it('an applied version whose parse throws applies as on a first start', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appliedStore = memoryAppliedStore();
    const folder = `/home/me/.consola/workspaces/${WORKSPACE_ID}`;
    appliedStore.records.set(folder, {
      folder,
      appliedAt: '2026-11-15T08:00:00.000Z',
      clean: true,
      texts: { 'factory.yml': `${NIGHTLY}# parse-throws\n` },
    });
    const h = await stepsHarness({ yaml: NIGHTLY, appliedStore });
    expect(names(h)).toEqual(['nightly']);
    expect(h.service.snapshot(WORKSPACE_ID).standing).toBeUndefined();
    expect(logged).toHaveBeenCalledWith(
      `Could not parse ${folder}'s applied factory; it applies as on a first start.`,
      expect.objectContaining({ message: expect.stringContaining('the parser fell over') }),
    );
  });

  it('a host check that throws while a folder loads does not stop the start', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { on: true };
    const harness = {
      name: 'Claude',
      get problem(): string | null {
        if (failing.on) throw new Error('the host fell over');
        return null;
      },
    };
    // `stepsHarness` awaits the start: it rejects if the start does.
    const h = await stepsHarness({ yaml: NIGHTLY, harness });
    expect(logged).toHaveBeenCalledWith(
      `Could not load ${WORKSPACE_ID}'s factory folder.`,
      expect.objectContaining({ message: 'the host fell over' }),
    );
    failing.on = false;
    await h.service.recheck(WORKSPACE_ID);
    expect(names(h)).toEqual(['nightly']);
  });

  it('a reload from the watcher that throws is logged, never an unhandled rejection', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { on: false };
    const harness = {
      name: 'Claude',
      get problem(): string | null {
        if (failing.on) throw new Error('the host fell over');
        return null;
      },
    };
    const h = await stepsHarness({ yaml: NIGHTLY, harness });
    failing.on = true;
    h.world.watchers.get(WORKSPACE_ID)!();
    await h.flush();
    expect(logged).toHaveBeenCalledWith(
      `Could not reload ${WORKSPACE_ID}'s factory folder.`,
      expect.objectContaining({ message: 'the host fell over' }),
    );
  });
});
