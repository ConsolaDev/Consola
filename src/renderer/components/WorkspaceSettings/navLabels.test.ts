import { describe, expect, it } from 'vitest';
import { createWorkspaceRecord, type Workspace } from '../../../shared/workspace';
import { providerNavLabel } from './navLabels';

/** Built from the real record factory so the fixture tracks the record shape. */
function workspaceWith(provider: Workspace['provider']): Workspace {
  return { ...createWorkspaceRecord('w', '/tmp/w', false), provider };
}

describe('providerNavLabel', () => {
  it('reads generically before anything is bound', () => {
    expect(providerNavLabel(workspaceWith(undefined))).toBe('Provider');
  });

  it("reads the bound provider's own display name", () => {
    expect(providerNavLabel(workspaceWith({ id: 'github', accountLogin: 'SymJavi' }))).toBe(
      'GitHub'
    );
  });

  it('falls back rather than throwing on an id PROVIDER_META no longer lists', () => {
    // A persisted binding outlives the code that wrote it; the modal must
    // still render so the user can unbind or delete from it.
    const stale = { id: 'gitlab', accountLogin: 'x' } as unknown as NonNullable<
      Workspace['provider']
    >;
    expect(providerNavLabel(workspaceWith(stale))).toBe('Provider');
  });
});
