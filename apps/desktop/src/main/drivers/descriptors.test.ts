import { describe, expect, it } from 'vitest';
import { getDriverDescriptor } from '../../shared/constants';
import { getDriver } from './index';

describe('driver descriptors', () => {
  it.each(['claude', 'codex'] as const)('%s declares exactly what its driver implements', (id) => {
    const driver = getDriver(id);
    const d = getDriverDescriptor(id);
    expect(Boolean(d.defaultTitleModel)).toBe(typeof driver.generateText === 'function');
    expect(d.supportsConversationReading).toBe(typeof driver.readConversation === 'function');
    expect(d.supportsCapabilities).toBe(typeof driver.probeCapabilities === 'function');
  });
});
