import { create } from 'zustand';
import type { BrowserAuthRequestMessage } from '../../shared/browser';

/**
 * Sign-in requests main is holding for this window's pages. Per window and
 * never persisted: main owns each request (and cancels it), this only lets the
 * tab's page draw it.
 */
interface BrowserAuthState {
  requests: BrowserAuthRequestMessage[];
}

export const useBrowserAuthStore = create<BrowserAuthState>(() => ({ requests: [] }));

/** A request is new, or main told us more about one we have (its tab). */
export function putAuthRequest(request: BrowserAuthRequestMessage): void {
  useBrowserAuthStore.setState((state) => ({
    requests: [...state.requests.filter((r) => r.id !== request.id), request],
  }));
}

export function dropAuthRequest(id: string): void {
  useBrowserAuthStore.setState((state) => ({
    requests: state.requests.filter((r) => r.id !== id),
  }));
}
