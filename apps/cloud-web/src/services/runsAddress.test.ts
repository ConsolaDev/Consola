import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FILTERS, togglePhase } from '../domain/runFilters';
import { currentRunsHash, onRunsAddressChange, showRunPlace, showRunsFilters } from './runsAddress';

/** The tests run in Node, so the page's `window` is a stand-in with just what the module reads. */
function pageAt(hash: string) {
  const location = { pathname: '/', search: '?tab=1', hash };
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    location.hash = url.slice(url.indexOf('#'));
  });
  const heard = new Set<() => void>();
  vi.stubGlobal('window', {
    location,
    history: { state: { kept: true }, replaceState },
    addEventListener: (_type: string, listener: () => void) => heard.add(listener),
    removeEventListener: (_type: string, listener: () => void) => heard.delete(listener),
  });
  return { replaceState, heard };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('showRunsFilters', () => {
  it('puts the filters in the address in place of its entry, keeping the rest', () => {
    const { replaceState } = pageAt('#/runs');
    showRunsFilters(togglePhase(NO_FILTERS, 'failed'));
    expect(replaceState).toHaveBeenCalledWith({ kept: true }, '', '/?tab=1#/runs?phase=failed');
    expect(currentRunsHash()).toBe('#/runs?phase=failed');
  });

  it('tells whoever listens, since replacing the entry fires no hashchange', () => {
    pageAt('#/runs');
    const listener = vi.fn();
    const stop = onRunsAddressChange(listener);
    showRunsFilters(togglePhase(NO_FILTERS, 'active'));
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    showRunsFilters(NO_FILTERS);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves an address that already says it alone', () => {
    const { replaceState } = pageAt('#/runs?phase=failed');
    showRunsFilters(togglePhase(NO_FILTERS, 'failed'));
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('onRunsAddressChange', () => {
  it('hears links followed and back and forward', () => {
    const { heard } = pageAt('#/runs');
    const listener = vi.fn();
    const stop = onRunsAddressChange(listener);
    for (const hashchange of heard) hashchange();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    expect(heard.size).toBe(0);
  });
});

describe('showRunPlace', () => {
  it('puts the view and the step in the address in place of its entry, and tells listeners', () => {
    const { replaceState } = pageAt('#/runs/run-1');
    const listener = vi.fn();
    const stop = onRunsAddressChange(listener);
    showRunPlace('run-1', { view: 'file', step: 'build', run: null });
    expect(replaceState).toHaveBeenCalledWith(
      { kept: true },
      '',
      '/?tab=1#/runs/run-1?view=file&step=build',
    );
    expect(listener).toHaveBeenCalledTimes(1);
    showRunPlace('run-1', { view: 'file', step: 'build', run: null });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});
