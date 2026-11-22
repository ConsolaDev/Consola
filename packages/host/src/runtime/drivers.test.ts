import { describe, expect, it } from 'vite-plus/test';
import { ProviderInstanceId } from '@t3tools/contracts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import {
  DRIVER_KIND_BY_HARNESS,
  defaultModelSelection,
  HOST_DRIVERS,
  hostDriverFor,
  titleModelSelection,
} from './drivers.ts';

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

describe('hostDriverFor', () => {
  it("is the one guarded driver of the session's harness", () => {
    for (const [harness, kind] of Object.entries(DRIVER_KIND_BY_HARNESS)) {
      const driver = hostDriverFor(harness as SessionSpec['harness']);
      expect(driver.driverKind).toBe(kind);
      expect(HOST_DRIVERS).toContain(driver);
    }
  });
});

describe('titleModelSelection', () => {
  const spec = (
    harness: SessionSpec['harness'],
    modelSelection?: SessionSpec['modelSelection'],
  ) => ({
    sessionId: 'session-sprocket',
    harness,
    cwd: '/tmp/sprocket',
    ...(modelSelection === undefined ? {} : { modelSelection }),
  });

  it("titles on the session's provider, with t3's text model for its driver", () => {
    expect(titleModelSelection(spec('claude'))).toEqual({
      instanceId: 'claudeAgent',
      model: 'claude-haiku-5-5',
    });
    expect(titleModelSelection(spec('codex'))).toEqual({
      instanceId: 'codex',
      model: 'gpt-6-luna',
    });
    // No text model of its own: t3 falls back to the driver's default model.
    expect(titleModelSelection(spec('pi'))).toEqual({ instanceId: 'pi', model: 'default' });
  });

  it("uses the session's own instance", () => {
    expect(
      titleModelSelection(
        spec('claude', {
          instanceId: ProviderInstanceId.make('claude-sprocket'),
          model: 'claude-opus-5-5',
        }),
      ),
    ).toEqual({ instanceId: 'claude-sprocket', model: 'claude-haiku-5-5' });
  });
});
