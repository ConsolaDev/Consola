import { describe, expect, it } from 'vitest';
import { personAsking } from './person.js';

describe('personAsking', () => {
  const dana = { id: 'dana', name: 'Dana Ortiz', email: 'dana@acme.test', image: null };

  it('is the person by id, with the workspace their session has active', () => {
    expect(personAsking({ sessionId: 's-1', person: dana, activeWorkspaceId: 'acme' })).toEqual({
      personId: 'dana',
      activeWorkspaceId: 'acme',
    });
    expect(personAsking({ sessionId: 's-1', person: dana, activeWorkspaceId: null })).toEqual({
      personId: 'dana',
      activeWorkspaceId: null,
    });
  });

  it('carries nothing else of the account', () => {
    const asking = personAsking({ sessionId: 's-1', person: dana, activeWorkspaceId: 'acme' });
    expect(Object.keys(asking ?? {}).sort()).toEqual(['activeWorkspaceId', 'personId']);
  });

  it('is null with no session', () => {
    expect(personAsking(null)).toBeNull();
  });
});
