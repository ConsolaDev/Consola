import { describe, expect, it } from 'vitest';
import { sectionIdOfHash } from './sections';
import {
  hashOfNewSession,
  hashOfSession,
  hashOfSessions,
  SESSIONS_SECTION_ID,
  sessionsRouteOfHash,
} from './sessionsRoute';

describe('sessionsRouteOfHash', () => {
  it('is the list for the section alone, and for a hash it cannot read', () => {
    expect(sessionsRouteOfHash('#/sessions')).toEqual({ kind: 'list' });
    expect(sessionsRouteOfHash('#/sessions/')).toEqual({ kind: 'list' });
    expect(sessionsRouteOfHash('#/sessions?x=1')).toEqual({ kind: 'list' });
    expect(sessionsRouteOfHash('#/sessions/a/b')).toEqual({ kind: 'list' });
    expect(sessionsRouteOfHash('#/sessions/%E0%A4%A')).toEqual({ kind: 'list' });
    expect(sessionsRouteOfHash('#/runs/1')).toEqual({ kind: 'list' });
  });

  it('is the new session form', () => {
    expect(sessionsRouteOfHash('#/sessions/new')).toEqual({ kind: 'new' });
    expect(sessionsRouteOfHash('#/sessions/new/')).toEqual({ kind: 'new' });
  });

  it('is one session, by its id', () => {
    expect(sessionsRouteOfHash('#/sessions/1a2b3c4d-5e6f')).toEqual({
      kind: 'session',
      sessionId: '1a2b3c4d-5e6f',
    });
    expect(sessionsRouteOfHash('#/sessions/a%2Fb?x')).toEqual({
      kind: 'session',
      sessionId: 'a/b',
    });
  });
});

describe('the hashes', () => {
  it('name the section, the form and a session, and each reads back', () => {
    expect(SESSIONS_SECTION_ID).toBe('sessions');
    expect(hashOfSessions()).toBe('#/sessions');
    expect(hashOfNewSession()).toBe('#/sessions/new');
    expect(hashOfSession('a/b')).toBe('#/sessions/a%2Fb');
    for (const hash of [hashOfSessions(), hashOfNewSession(), hashOfSession('a/b')]) {
      expect(sectionIdOfHash(hash)).toBe(SESSIONS_SECTION_ID);
    }
    expect(sessionsRouteOfHash(hashOfSession('a/b'))).toEqual({
      kind: 'session',
      sessionId: 'a/b',
    });
  });
});
