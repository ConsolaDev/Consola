import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import {
  EMPTY_VIEW,
  ViewMemoryService,
  normalizeView,
  resolveRememberedView,
  type ViewMemoryStateFile,
} from './ViewMemoryService';
import type { WorkspaceView } from '../../shared/types';
import type { Workspace } from '../../shared/workspace';

let dir: string;
let service: ViewMemoryService;

function filePath(): string {
  return path.join(dir, 'view-memory.json');
}

function build(): ViewMemoryService {
  const built = new ViewMemoryService(new JsonStateFile<ViewMemoryStateFile>(filePath()));
  built.load();
  return built;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-view-memory-'));
  service = build();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A workspace with the two fields resolution actually reads. */
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1',
    name: 'alpha',
    defaultHarnessId: 'default',
    scopes: [],
    groups: [],
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Workspace;
}

/** The shape of a session, as far as resolution cares. */
function session(id: string) {
  return { id } as Workspace['sessions'][number];
}

describe('resolveRememberedView', () => {
  it('keeps the automations overlay while dropping a dangling session', () => {
    const workspace = { sessions: [session('s1')] } as Workspace;

    expect(resolveRememberedView({ activeSessionId: 'gone', overlay: 'automations' }, workspace)).toEqual({
      activeSessionId: null,
      overlay: 'automations',
    });
  });

  it('returns the empty view when the workspace is gone', () => {
    const view: WorkspaceView = { activeSessionId: 's1', overlay: 'inbox' };

    expect(resolveRememberedView(view, undefined)).toEqual(EMPTY_VIEW);
  });

  it('keeps a session that still exists', () => {
    const workspace = makeWorkspace({ sessions: [session('s1'), session('s2')] });

    expect(resolveRememberedView({ activeSessionId: 's2', overlay: null }, workspace)).toEqual({
      activeSessionId: 's2',
      overlay: null,
    });
  });

  it('drops a session that has been deleted, and never substitutes another one', () => {
    // Substituting the most recent session would mount its pane and spawn a
    // PTY the user never asked for. Landing on the composer is the only safe
    // answer here.
    const workspace = makeWorkspace({ sessions: [session('s1')] });

    expect(resolveRememberedView({ activeSessionId: 'gone', overlay: null }, workspace)).toEqual(
      { activeSessionId: null, overlay: null }
    );
  });

  it('treats a remembered composer as a real answer, not as nothing remembered', () => {
    const workspace = makeWorkspace({ sessions: [session('s1')] });

    expect(resolveRememberedView({ activeSessionId: null, overlay: null }, workspace)).toEqual(
      EMPTY_VIEW
    );
  });

  it('keeps the Inbox open for a workspace that is still bound to a provider', () => {
    const workspace = makeWorkspace({
      sessions: [session('s1')],
      provider: { id: 'github', accountLogin: 'someone' },
    } as Partial<Workspace>);

    expect(resolveRememberedView({ activeSessionId: 's1', overlay: 'inbox' }, workspace)).toEqual({
      activeSessionId: 's1',
      overlay: 'inbox',
    });
  });

  it('keeps integration onboarding open without a provider binding', () => {
    const workspace = makeWorkspace({ sessions: [session('s1')] });

    expect(resolveRememberedView({ activeSessionId: 's1', overlay: 'inbox' }, workspace)).toEqual({
      activeSessionId: 's1',
      overlay: 'inbox',
    });
  });
});

describe('normalizeView', () => {
  it('accepts every shape we write', () => {
    expect(normalizeView({ activeSessionId: 's1', overlay: 'inbox' })).toEqual({ activeSessionId: 's1', overlay: 'inbox' });
    expect(normalizeView({ activeSessionId: 's1', overlay: 'automations' })).toEqual({ activeSessionId: 's1', overlay: 'automations' });
    expect(normalizeView({ activeSessionId: null, overlay: null })).toEqual({ activeSessionId: null, overlay: null });
  });

  it('reads the legacy inbox flag as an overlay', () => {
    expect(normalizeView({ activeSessionId: 's1', isInboxOpen: true })).toEqual({ activeSessionId: 's1', overlay: 'inbox' });
    expect(normalizeView({ activeSessionId: null, isInboxOpen: false })).toEqual({ activeSessionId: null, overlay: null });
  });

  it('rejects anything that is not an object', () => {
    expect(normalizeView(null)).toBeNull();
    expect(normalizeView('s1')).toBeNull();
    expect(normalizeView(undefined)).toBeNull();
  });

  it('rejects a session id that is neither a string nor null', () => {
    expect(normalizeView({ activeSessionId: 7, overlay: null })).toBeNull();
  });

  it('rejects a missing overlay and a non-boolean legacy flag', () => {
    expect(normalizeView({ activeSessionId: null })).toBeNull();
    expect(normalizeView({ activeSessionId: null, isInboxOpen: 'yes' })).toBeNull();
  });

  it('rejects an unknown overlay value', () => {
    expect(normalizeView({ activeSessionId: null, overlay: 'settings' })).toBeNull();
  });
});

describe('ViewMemoryService', () => {
  it('reads a legacy isInboxOpen entry as the inbox overlay, and writes the new shape', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        views: {
          w1: { activeSessionId: 's1', isInboxOpen: true },
          w2: { activeSessionId: null, isInboxOpen: false },
        },
      })
    );

    const rebuilt = build();
    expect(rebuilt.get('w1')).toEqual({ activeSessionId: 's1', overlay: 'inbox' });
    expect(rebuilt.get('w2')).toEqual({ activeSessionId: null, overlay: null });

    const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(stored.views.w1).toEqual({ activeSessionId: 's1', overlay: 'inbox' });
    expect(stored.views.w2).toEqual({ activeSessionId: null, overlay: null });
  });

  it('tells apart two views that differ only in their overlay', () => {
    service.set('w1', { activeSessionId: 's1', overlay: 'inbox' });
    service.set('w1', { activeSessionId: 's1', overlay: 'automations' });

    expect(build().get('w1')).toEqual({ activeSessionId: 's1', overlay: 'automations' });
  });

  it('returns the empty view for a workspace it has never been told about', () => {
    expect(service.get('unknown')).toEqual(EMPTY_VIEW);
  });

  it('reads back what it was told', () => {
    service.set('w1', { activeSessionId: 's1', overlay: 'inbox' });

    expect(service.get('w1')).toEqual({ activeSessionId: 's1', overlay: 'inbox' });
  });

  it('persists a view immediately, so a force-quit cannot lose it', () => {
    service.set('w1', { activeSessionId: 's1', overlay: null });

    // No save() call in between: the write happens on set, which is the whole
    // point of not deferring it to quit.
    expect(build().get('w1')).toEqual({ activeSessionId: 's1', overlay: null });
  });

  it('remembers the composer as its own state, distinct from never having visited', () => {
    service.set('w1', { activeSessionId: null, overlay: null });

    const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as ViewMemoryStateFile;
    expect(stored.views.w1).toEqual({ activeSessionId: null, overlay: null });
  });

  it('skips the write when the view has not actually changed', () => {
    service.set('w1', { activeSessionId: 's1', overlay: null });
    const firstWrite = fs.statSync(filePath()).mtimeMs;

    service.set('w1', { activeSessionId: 's1', overlay: null });

    // Clicking the session you are already on should cost nothing.
    expect(fs.statSync(filePath()).mtimeMs).toBe(firstWrite);
  });

  it('drops workspaces that no longer exist, and keeps the rest', () => {
    service.set('w1', { activeSessionId: 's1', overlay: null });
    service.set('w2', { activeSessionId: 's2', overlay: null });

    service.prune(new Set(['w2']));

    expect(service.get('w1')).toEqual(EMPTY_VIEW);
    expect(service.get('w2')).toEqual({ activeSessionId: 's2', overlay: null });
    expect(build().get('w1')).toEqual(EMPTY_VIEW);
  });

  it('starts empty and does not throw when the file cannot be parsed', () => {
    // Losing this file costs every workspace its remembered view, which is
    // what a workspace with no memory already does — never a reason to refuse
    // to launch, unlike workspaces.json.
    fs.writeFileSync(filePath(), '{ not json');

    let rebuilt: ViewMemoryService | undefined;
    expect(() => {
      rebuilt = build();
    }).not.toThrow();
    expect(rebuilt?.isEmpty()).toBe(true);
  });

  it('skips one malformed entry while keeping the sound ones beside it', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        views: {
          w1: { activeSessionId: 's1', overlay: null },
          w2: { activeSessionId: 7, overlay: null },
        },
      })
    );

    const rebuilt = build();
    expect(rebuilt.get('w1')).toEqual({ activeSessionId: 's1', overlay: null });
    expect(rebuilt.get('w2')).toEqual(EMPTY_VIEW);
  });

  it('reports empty only until something is remembered', () => {
    expect(service.isEmpty()).toBe(true);
    service.set('w1', EMPTY_VIEW);
    expect(service.isEmpty()).toBe(false);
  });

  it('seeds carried-over views in one write, and persists them', () => {
    service.seed({
      w1: { activeSessionId: 's1', overlay: null },
      w2: { activeSessionId: 's2', overlay: null },
    });

    expect(build().get('w1')).toEqual({ activeSessionId: 's1', overlay: null });
    expect(build().get('w2')).toEqual({ activeSessionId: 's2', overlay: null });
  });

  it('writes nothing when there is nothing to seed', () => {
    service.seed({});

    expect(service.isEmpty()).toBe(true);
    expect(fs.existsSync(filePath())).toBe(false);
  });
});
