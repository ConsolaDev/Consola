import { beforeEach, describe, expect, it } from 'vitest';
import {
  addressFocusAnswer,
  requestAddressFocus,
  settleAddressFocus,
  useAddressFocusStore,
} from './addressFocusStore';

describe('the address bar’s focus requests', () => {
  beforeEach(() => {
    useAddressFocusStore.setState({ requests: 0, tabId: null, settled: 0 });
  });

  const answer = (tabId: string | null, moment: 'asked' | 'shown') =>
    addressFocusAnswer(useAddressFocusStore.getState(), tabId, moment);

  it('gives a request for no tab in particular to the bar on screen, once', () => {
    requestAddressFocus();
    expect(answer('t1', 'asked')).toBe('take');
    settleAddressFocus();
    expect(answer('t1', 'asked')).toBe('leave');
  });

  it('never hands a request for no tab in particular to a bar that appears later', () => {
    requestAddressFocus();
    expect(answer('t1', 'shown')).toBe('drop');
  });

  it('keeps a request for a tab until that tab’s bar is on screen, and gives it no other', () => {
    requestAddressFocus('t2');
    // The bar on screen is still the previous tab's.
    expect(answer('t1', 'asked')).toBe('leave');
    // The new tab's bar appears, or the bar finds itself on that tab.
    expect(answer('t2', 'shown')).toBe('take');
    settleAddressFocus();
    expect(answer('t2', 'shown')).toBe('leave');
  });

  it('gives a request for a tab whose bar is already on screen to it at once', () => {
    requestAddressFocus('t2');
    expect(answer('t2', 'asked')).toBe('take');
  });

  it('drops a request for a tab once another tab’s bar shows first', () => {
    requestAddressFocus('t2');
    expect(answer('t3', 'shown')).toBe('drop');
    settleAddressFocus();
    // Coming back to the tab later does not pull the keyboard there.
    expect(answer('t2', 'shown')).toBe('leave');
  });

  it('lets a later request replace one still waiting', () => {
    requestAddressFocus('t2');
    requestAddressFocus('t3');
    expect(answer('t2', 'asked')).toBe('leave');
    expect(answer('t3', 'shown')).toBe('take');
  });
});
