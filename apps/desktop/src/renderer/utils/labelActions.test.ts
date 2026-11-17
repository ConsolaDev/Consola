import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DragEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonStateFile } from '../../main/state/JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from '../../main/state/WorkspaceService';
import { SESSION_DRAG_TYPE } from '../components/Sidebar/sessionDrag';
import { useSessionFilterStore } from '../stores/sessionFilterStore';
import { dismissToast, useToastStore } from '../stores/toastStore';
import { createAndSelectLabel, deleteLabelWithUndo, dropSessionOnLabel } from './labelActions';
import { effectiveFilters } from './sessionFilters';

/**
 * The filter bar's label gestures, end to end: the real workspace service
 * behind the bridge, the real filter store, the real toast. Deleting a label
 * is the one gesture in a filtering menu that destroys something a person
 * authored, so what is asserted here is what they get back.
 */
let dir: string;
let service: WorkspaceService;
let workspaceId: string;
let sessionIds: string[];

/** Let the promises a toast action starts settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const workspace = () => service.getAll()[0];
const sessionsOf = () => workspace().sessions;
const labelsOn = (sessionId: string) =>
  sessionsOf().find((session) => session.id === sessionId)?.labelIds;
const toasts = () => useToastStore.getState().toasts;
const chips = () =>
  effectiveFilters(workspace(), sessionsOf(), useSessionFilterStore.getState().filters[workspaceId])
    .label;

/** A drop carrying a session row, as the chip receives it. */
function drop(sessionId: string | null) {
  const prevented = vi.fn();
  const event = {
    preventDefault: prevented,
    dataTransfer: {
      getData: (type: string) => (type === SESSION_DRAG_TYPE && sessionId ? sessionId : ''),
    },
  } as unknown as DragEvent;
  return { event, prevented };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-label-actions-'));
  service = new WorkspaceService(
    new JsonStateFile<WorkspaceStateFile>(path.join(dir, 'workspaces.json')),
  );
  service.load();
  const created = service.createWorkspace('W', '/w', false);
  workspaceId = created.id;
  sessionIds = ['A', 'B'].map(
    (name) =>
      service.createSession(created.id, {
        name,
        workspaceId: created.id,
        instanceId: `i-${name}`,
        harnessId: 'default-agent',
        model: undefined,
        scopeId: created.scopes[0].id,
      })!.id,
  );
  // The bridge's own seam, with main's real service on the other side of it.
  (globalThis as { window?: unknown }).window = {
    workspaceAPI: {
      createLabel: async (id: string, fields: { name: string }) => service.createLabel(id, fields),
      deleteLabel: async (id: string, labelId: string) => service.deleteLabel(id, labelId),
      restoreLabel: async (id: string, removed: Parameters<WorkspaceService['restoreLabel']>[1]) =>
        service.restoreLabel(id, removed),
      assignLabel: async (id: string, sessionId: string, labelId: string) =>
        service.assignLabel(id, sessionId, labelId),
    },
  };
  for (const toast of toasts()) dismissToast(toast.id);
  useSessionFilterStore.getState().clear(workspaceId);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { window?: unknown }).window;
});

describe('deleting a label from the filter bar', () => {
  const seedLabel = () => {
    const label = service.createLabel(workspaceId, { name: 'Flaky', emoji: '🐛' });
    service.assignLabel(workspaceId, sessionIds[0], label.id);
    service.assignLabel(workspaceId, sessionIds[1], label.id);
    return label;
  };

  it('deletes it, names it, and offers Undo', async () => {
    const label = seedLabel();

    await deleteLabelWithUndo(workspaceId, label);

    expect(workspace().labels).toEqual([]);
    expect(labelsOn(sessionIds[0])).toBeUndefined();
    const [toast] = toasts();
    expect(toast.message).toContain('Flaky');
    expect(toast.action?.label).toBe('Undo');
  });

  it('Undo brings the label back, on exactly the sessions that carried it', async () => {
    const label = seedLabel();
    service.unassignLabel(workspaceId, sessionIds[1], label.id); // only A carries it

    await deleteLabelWithUndo(workspaceId, label);
    toasts()[0].action!.run();
    await flush();

    expect(workspace().labels).toEqual([{ id: label.id, name: 'Flaky', emoji: '🐛' }]);
    expect(labelsOn(sessionIds[0])).toEqual([label.id]);
    expect(labelsOn(sessionIds[1]) ?? []).toEqual([]);
  });

  it('Undo brings its chip back too, so the list is narrowed as it was', async () => {
    const label = seedLabel();
    useSessionFilterStore.getState().toggle(workspaceId, 'label', label.id);
    expect(chips()).toEqual([label.id]);

    await deleteLabelWithUndo(workspaceId, label);
    expect(chips()).toBeUndefined();

    toasts()[0].action!.run();
    await flush();
    expect(chips()).toEqual([label.id]);
  });

  it('Undo cannot be run twice: the toast goes with it', async () => {
    const label = seedLabel();

    await deleteLabelWithUndo(workspaceId, label);
    toasts()[0].action!.run();
    await flush();

    expect(toasts()).toHaveLength(0);
    expect(workspace().labels).toHaveLength(1);
  });

  it('says nothing and offers no Undo when there was nothing to delete', async () => {
    await deleteLabelWithUndo(workspaceId, { id: 'gone', name: 'Gone' });

    expect(toasts()).toEqual([]);
  });
});

describe('making a label from the filter bar', () => {
  it('creates it and narrows the list to it at once', async () => {
    const label = await createAndSelectLabel(workspaceId, '  Flaky  ');

    expect(label?.name).toBe('Flaky');
    expect(workspace().labels.map((candidate) => candidate.name)).toEqual(['Flaky']);
    expect(useSessionFilterStore.getState().filters[workspaceId]?.label).toEqual([label!.id]);
  });

  it('makes nothing from an empty name, and changes no selection', async () => {
    expect(await createAndSelectLabel(workspaceId, '   ')).toBeNull();

    expect(workspace().labels).toEqual([]);
    expect(useSessionFilterStore.getState().filters[workspaceId]).toBeUndefined();
  });
});

describe('dropping a session row on a label chip', () => {
  it('gives that session the label', async () => {
    const label = service.createLabel(workspaceId, { name: 'Flaky' });
    const { event, prevented } = drop(sessionIds[1]);

    await dropSessionOnLabel(workspaceId, event, label.id);

    expect(labelsOn(sessionIds[1])).toEqual([label.id]);
    // Without it the browser refuses the drop outright.
    expect(prevented).toHaveBeenCalled();
  });

  it('does nothing when the drop carried no session', async () => {
    const label = service.createLabel(workspaceId, { name: 'Flaky' });

    await dropSessionOnLabel(workspaceId, drop(null).event, label.id);

    expect(sessionsOf().some((session) => session.labelIds?.length)).toBe(false);
  });

  it('reports a drop on a label that has gone, rather than failing silently', async () => {
    await expect(
      dropSessionOnLabel(workspaceId, drop(sessionIds[0]).event, 'gone'),
    ).rejects.toThrow(/No label/);
  });
});
