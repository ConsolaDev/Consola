import { describe, expect, it } from 'vitest';
import type { OpenInTarget } from '../../shared/openIn';
import { favouriteTarget } from './favourite';

const VS_CODE: OpenInTarget = { id: 'vscode', label: 'VS Code', kind: 'app' };
const INTELLIJ: OpenInTarget = { id: 'intellij', label: 'IntelliJ IDEA', kind: 'app' };
const FINDER: OpenInTarget = { id: 'finder', label: 'Finder', kind: 'file-manager' };
const FILE_MANAGER: OpenInTarget = {
  id: 'file-manager',
  label: 'File Manager',
  kind: 'file-manager',
};

describe('favouriteTarget', () => {
  it('is Finder before any pick', () => {
    expect(favouriteTarget([VS_CODE, INTELLIJ, FINDER], null)).toBe(FINDER);
  });

  it('is the last app picked while it is installed', () => {
    expect(favouriteTarget([VS_CODE, INTELLIJ, FINDER], 'intellij')).toBe(INTELLIJ);
    expect(favouriteTarget([VS_CODE, INTELLIJ, FINDER], 'finder')).toBe(FINDER);
  });

  it('is Finder again once the app picked is no longer installed', () => {
    expect(favouriteTarget([VS_CODE, FINDER], 'intellij')).toBe(FINDER);
  });

  it('is the file manager off macOS', () => {
    expect(favouriteTarget([FILE_MANAGER], null)).toBe(FILE_MANAGER);
    expect(favouriteTarget([FILE_MANAGER], 'vscode')).toBe(FILE_MANAGER);
  });

  it('is nothing while no list has come', () => {
    expect(favouriteTarget([], 'vscode')).toBeUndefined();
  });
});
