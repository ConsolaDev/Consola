import { useMemo, useSyncExternalStore } from 'react';
import { sessionsRouteOfHash } from '../domain/sessionsRoute';
import { currentHash, onHashChange } from '../services/address';
import { NewSessionPage } from './NewSessionPage';
import { SessionPage } from './SessionPage';
import { SessionsList } from './SessionsList';
import type { SectionProps } from './sections';
import './Sessions.css';

/**
 * The Sessions section: the person's cloud sessions (`#/sessions`), the form that starts one
 * (`#/sessions/new`) or one session (`#/sessions/<id>`), whichever the address names. All of them
 * live in the API, and each person sees only their own.
 */
export function SessionsSection({ workspace }: SectionProps) {
  const hash = useSyncExternalStore(onHashChange, currentHash);
  const route = useMemo(() => sessionsRouteOfHash(hash), [hash]);

  switch (route.kind) {
    case 'list':
      return <SessionsList workspace={workspace} />;
    case 'new':
      return <NewSessionPage workspace={workspace} />;
    case 'session':
      return (
        <SessionPage key={route.sessionId} workspace={workspace} sessionId={route.sessionId} />
      );
  }
}
