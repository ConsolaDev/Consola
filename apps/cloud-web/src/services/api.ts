import type { Me, MeState, Org } from '../domain/me';

/**
 * Who is signed in. Only a 401 means signed out and only a 403 means not a member: a failed
 * fetch, a 5xx from the service or the proxy, or a body that is not JSON is `unavailable`, so a
 * service that is down never looks like a signed-out person.
 */
export async function loadMe(fetchFn: typeof fetch = fetch): Promise<MeState> {
  try {
    const response = await fetchFn('/api/me', { credentials: 'same-origin' });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 403) return { kind: 'not-member' };
    if (!response.ok) return { kind: 'unavailable' };
    return { kind: 'signed-in', me: (await response.json()) as Me };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The deployment's organisation, or null when the service does not answer. */
export async function loadOrg(fetchFn: typeof fetch = fetch): Promise<Org | null> {
  try {
    const response = await fetchFn('/api/org');
    if (!response.ok) return null;
    return (await response.json()) as Org;
  } catch {
    return null;
  }
}
