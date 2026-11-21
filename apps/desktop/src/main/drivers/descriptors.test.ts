import { describe, expect, it } from 'vitest';
import { getDriverDescriptor, HARNESS_DRIVERS } from '../../shared/constants';
import { getDriver } from './index';

describe('driver descriptors', () => {
  it.each(HARNESS_DRIVERS.map((driver) => driver.id))(
    '%s declares exactly what its driver implements',
    (id) => {
      const driver = getDriver(id);
      const d = getDriverDescriptor(id);
      expect(Boolean(d.defaultTitleModel)).toBe(typeof driver.generateText === 'function');
      expect(d.supportsConversationReading).toBe(typeof driver.readConversation === 'function');
      expect(d.supportsCapabilities).toBe(typeof driver.probeCapabilities === 'function');
      expect(d.configDirEnvVar).toBe(driver.configDirEnvVar);
    },
  );
});
