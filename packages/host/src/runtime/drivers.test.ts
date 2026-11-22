import { describe, expect, it } from 'vite-plus/test';
import { DRIVER_KIND_BY_HARNESS, defaultModelSelection, HOST_DRIVERS } from './drivers.ts';

describe('HOST_DRIVERS', () => {
  it("lists t3's drivers for the five harnesses, in t3's order", () => {
    expect(HOST_DRIVERS.map((driver) => driver.driverKind)).toEqual([
      'codex',
      'claudeAgent',
      'opencode',
      'pi',
      'acpRegistry',
    ]);
  });

  it('never includes Cursor', () => {
    expect(HOST_DRIVERS.map((driver) => driver.driverKind)).not.toContain('cursor');
  });

  it('has a driver for every harness a session can name', () => {
    const kinds = HOST_DRIVERS.map((driver) => driver.driverKind);
    for (const kind of Object.values(DRIVER_KIND_BY_HARNESS)) expect(kinds).toContain(kind);
  });
});

describe('defaultModelSelection', () => {
  it("picks t3's default model on the harness's default instance", () => {
    expect(defaultModelSelection('claude')).toEqual({
      instanceId: 'claudeAgent',
      model: 'claude-opus-5-5',
    });
    expect(defaultModelSelection('pi')).toEqual({ instanceId: 'pi', model: 'default' });
  });
});
