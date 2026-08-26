import { describe, expect, it } from 'vitest';
import { ipcErrorMessage } from './ipcErrorMessage';

describe('ipcErrorMessage', () => {
  it('strips the Electron invoke prefix and its nested Error: label', () => {
    const err = new Error(
      "Error invoking remote method 'workspace:set-actions': Error: An action needs a prompt."
    );
    expect(ipcErrorMessage(err)).toBe('An action needs a prompt.');
  });

  it('strips the prefix when main rejected with a plain string, not an Error', () => {
    const err = new Error("Error invoking remote method 'workspace:update-session': Unknown session.");
    expect(ipcErrorMessage(err)).toBe('Unknown session.');
  });

  it('leaves an unprefixed Error message untouched', () => {
    expect(ipcErrorMessage(new Error('Network unreachable.'))).toBe('Network unreachable.');
  });

  it('stringifies a non-Error value', () => {
    expect(ipcErrorMessage('just a string')).toBe('just a string');
    expect(ipcErrorMessage(42)).toBe('42');
  });
});
