import type { Me, MeState } from '../domain/me';

/**
 * Who is signed in. Only a 401 means signed out: a failed fetch, any other status from the
 * service or the proxy, or a body that is not JSON is `unavailable`, so a service that is down
 * never looks like a signed-out person.
 */
export async function loadMe(fetchFn: typeof fetch = fetch): Promise<MeState> {
  try {
    const response = await fetchFn('/api/me', { credentials: 'same-origin' });
    if (response.status === 401) return { kind: 'signed-out' };
    if (!response.ok) return { kind: 'unavailable' };
    return { kind: 'signed-in', me: (await response.json()) as Me };
  } catch {
    return { kind: 'unavailable' };
  }
}
