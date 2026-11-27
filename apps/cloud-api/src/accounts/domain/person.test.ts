import { describe, expect, it } from 'vitest';
import { personAsking } from './person.js';

describe('personAsking', () => {
  const dana = { id: 'dana', name: 'Dana Ortiz', email: 'dana@acme.test', image: null };

  it('is the person by id, in their session, with the workspace it has active', () => {
    expect(personAsking({ sessionId: 's-1', person: dana, activeWorkspaceId: 'acme' })).toEqual({
      personId: 'dana',
      sessionId: 's-1',
      activeWorkspaceId: 'acme',
    });
    expect(personAsking({ sessionId: 's-1', person: dana, activeWorkspaceId: null })).toEqual({
      personId: 'dana',
      sessionId: 's-1',
      activeWorkspaceId: null,
    });
  });

  it('carries nothing else of the account: no name, no email', () => {
    const asking = personAsking({ sessionId: 's-1', person: dana, activeWorkspaceId: 'acme' });
    expect(Object.keys(asking ?? {}).sort()).toEqual([
      'activeWorkspaceId',
      'personId',
      'sessionId',
    ]);
  });

  it('is null with no session', () => {
    expect(personAsking(null)).toBeNull();
  });
});
