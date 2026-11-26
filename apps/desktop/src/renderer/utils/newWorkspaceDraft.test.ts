import { describe, expect, it } from 'vitest';
import type { FolderInfo } from '../types/electron';
import {
  NEW_WORKSPACE_STEPS,
  WORKSPACE_LOCATIONS,
  canContinue,
  emptyDraft,
  mergeFolders,
} from './newWorkspaceDraft';
import type { NewWorkspaceDraft } from './newWorkspaceDraft';

const folder = (name: string, isGitRepo = true): FolderInfo => ({
  name,
  path: `/work/${name}`,
  isGitRepo,
});

describe('the new workspace steps', () => {
  it('asks where, then the name, then the folders', () => {
    expect(NEW_WORKSPACE_STEPS).toEqual(['location', 'name', 'folders']);
  });

  it('offers a cloud workspace without letting anyone pick it yet', () => {
    expect(WORKSPACE_LOCATIONS.map((location) => [location.id, location.available])).toEqual([
      ['local', true],
      ['cloud', false],
    ]);
  });

  it('starts local, unnamed and without folders', () => {
    expect(emptyDraft()).toEqual({ location: 'local', name: '', folders: [] });
  });
});

describe('canContinue', () => {
  const draft = (overrides: Partial<NewWorkspaceDraft> = {}): NewWorkspaceDraft => ({
    ...emptyDraft(),
    ...overrides,
  });

  it('moves on from the location only for one that is available', () => {
    expect(canContinue('location', draft())).toBe(true);
    expect(canContinue('location', draft({ location: 'cloud' }))).toBe(false);
  });

  it('needs a name with something in it besides spaces', () => {
    expect(canContinue('name', draft())).toBe(false);
    expect(canContinue('name', draft({ name: '   ' }))).toBe(false);
    expect(canContinue('name', draft({ name: 'Checkout' }))).toBe(true);
  });

  it('creates only with a name and at least one folder', () => {
    expect(canContinue('folders', draft({ name: 'Checkout' }))).toBe(false);
    expect(canContinue('folders', draft({ name: 'Checkout', folders: [folder('web')] }))).toBe(
      true,
    );
    expect(canContinue('folders', draft({ name: ' ', folders: [folder('web')] }))).toBe(false);
  });
});

describe('mergeFolders', () => {
  it('appends what was picked, in the order it was picked', () => {
    expect(mergeFolders([folder('web')], [folder('api'), folder('docs', false)])).toEqual([
      folder('web'),
      folder('api'),
      folder('docs', false),
    ]);
  });

  it('never lists one folder twice, whether picked again or twice at once', () => {
    expect(mergeFolders([folder('web')], [folder('web'), folder('api'), folder('api')])).toEqual([
      folder('web'),
      folder('api'),
    ]);
  });
});
