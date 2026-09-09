import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import {
  EMPTY_VIEW,
  ViewMemoryService,
  isValidView,
  resolveRememberedView,
  type ViewMemoryStateFile,
} from './ViewMemoryService';
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
  it('returns the empty view when the workspace is gone', () => {
    const view = { activeSessionId: 's1', isInboxOpen: true };

    expect(resolveRememberedView(view, undefined)).toEqual(EMPTY_VIEW);
  });

  it('keeps a session that still exists', () => {
    const workspace = makeWorkspace({ sessions: [session('s1'), session('s2')] });

    expect(resolveRememberedView({ activeSessionId: 's2', isInboxOpen: false }, workspace)).toEqual({
      activeSessionId: 's2',
      isInboxOpen: false,
    });
  });

  it('drops a session that has been deleted, and never substitutes another one', () => {
    // Substituting the most recent session would mount its pane and spawn a
    // PTY the user never asked for. Landing on the composer is the only safe
    // answer here.
    const workspace = makeWorkspace({ sessions: [session('s1')] });

    expect(resolveRememberedView({ activeSessionId: 'gone', isInboxOpen: false }, workspace)).toEqual(
      { activeSessionId: null, isInboxOpen: false }
    );
  });

  it('treats a remembered composer as a real answer, not as nothing remembered', () => {
    const workspace = makeWorkspace({ sessions: [session('s1')] });

    expect(resolveRememberedView({ activeSessionId: null, isInboxOpen: false }, workspace)).toEqual(
      EMPTY_VIEW
    );
  });

  it('keeps the Inbox open for a workspace that is still bound to a provider', () => {
    const workspace = makeWorkspace({
      sessions: [session('s1')],
      provider: { id: 'github', accountLogin: 'someone' },
    } as Partial<Workspace>);

    expect(resolveRememberedView({ activeSessionId: 's1', isInboxOpen: true }, workspace)).toEqual({
      activeSessionId: 's1',
      isInboxOpen: true,
    });
  });

  it('closes the Inbox when the provider has since been unbound', () => {
    // The sidebar only offers the Inbox to a bound workspace, so a remembered
    // `true` can outlive the binding it was set under.
    const workspace = makeWorkspace({ sessions: [session('s1')] });

    expect(resolveRememberedView({ activeSessionId: 's1', isInboxOpen: true }, workspace)).toEqual({
      activeSessionId: 's1',
      isInboxOpen: false,
    });
  });
});

describe('isValidView', () => {
  it('accepts both shapes we write', () => {
    expect(isValidView({ activeSessionId: 's1', isInboxOpen: true })).toBe(true);
    expect(isValidView({ activeSessionId: null, isInboxOpen: false })).toBe(true);
  });

  it('rejects anything that is not an object', () => {
    expect(isValidView(null)).toBe(false);
    expect(isValidView('s1')).toBe(false);
    expect(isValidView(undefined)).toBe(false);
  });

  it('rejects a session id that is neither a string nor null', () => {
    expect(isValidView({ activeSessionId: 7, isInboxOpen: false })).toBe(false);
  });

  it('rejects a missing or non-boolean inbox flag', () => {
    expect(isValidView({ activeSessionId: null })).toBe(false);
    expect(isValidView({ activeSessionId: null, isInboxOpen: 'yes' })).toBe(false);
  });
});

describe('ViewMemoryService', () => {
  it('returns the empty view for a workspace it has never been told about', () => {
    expect(service.get('unknown')).toEqual(EMPTY_VIEW);
  });

  it('reads back what it was told', () => {
    service.set('w1', { activeSessionId: 's1', isInboxOpen: true });

    expect(service.get('w1')).toEqual({ activeSessionId: 's1', isInboxOpen: true });
  });

  it('persists a view immediately, so a force-quit cannot lose it', () => {
    service.set('w1', { activeSessionId: 's1', isInboxOpen: false });

    // No save() call in between: the write happens on set, which is the whole
    // point of not deferring it to quit.
    expect(build().get('w1')).toEqual({ activeSessionId: 's1', isInboxOpen: false });
  });

  it('remembers the composer as its own state, distinct from never having visited', () => {
    service.set('w1', { activeSessionId: null, isInboxOpen: false });

    const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as ViewMemoryStateFile;
    expect(stored.views.w1).toEqual({ activeSessionId: null, isInboxOpen: false });
  });

  it('skips the write when the view has not actually changed', () => {
    service.set('w1', { activeSessionId: 's1', isInboxOpen: false });
    const firstWrite = fs.statSync(filePath()).mtimeMs;

    service.set('w1', { activeSessionId: 's1', isInboxOpen: false });

    // Clicking the session you are already on should cost nothing.
    expect(fs.statSync(filePath()).mtimeMs).toBe(firstWrite);
  });

  it('drops workspaces that no longer exist, and keeps the rest', () => {
    service.set('w1', { activeSessionId: 's1', isInboxOpen: false });
    service.set('w2', { activeSessionId: 's2', isInboxOpen: false });

    service.prune(new Set(['w2']));

    expect(service.get('w1')).toEqual(EMPTY_VIEW);
    expect(service.get('w2')).toEqual({ activeSessionId: 's2', isInboxOpen: false });
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
          w1: { activeSessionId: 's1', isInboxOpen: false },
          w2: { activeSessionId: 7, isInboxOpen: false },
        },
      })
    );

    const rebuilt = build();
    expect(rebuilt.get('w1')).toEqual({ activeSessionId: 's1', isInboxOpen: false });
    expect(rebuilt.get('w2')).toEqual(EMPTY_VIEW);
  });

  it('reports empty only until something is remembered', () => {
    expect(service.isEmpty()).toBe(true);
    service.set('w1', EMPTY_VIEW);
    expect(service.isEmpty()).toBe(false);
  });

  it('seeds carried-over views in one write, and persists them', () => {
    service.seed({
      w1: { activeSessionId: 's1', isInboxOpen: false },
      w2: { activeSessionId: 's2', isInboxOpen: false },
    });

    expect(build().get('w1')).toEqual({ activeSessionId: 's1', isInboxOpen: false });
    expect(build().get('w2')).toEqual({ activeSessionId: 's2', isInboxOpen: false });
  });

  it('writes nothing when there is nothing to seed', () => {
    service.seed({});

    expect(service.isEmpty()).toBe(true);
    expect(fs.existsSync(filePath())).toBe(false);
  });
});
