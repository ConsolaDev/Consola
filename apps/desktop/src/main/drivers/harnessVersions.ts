import type { HarnessLaunchFields, HarnessProbeResult } from '../../shared/types';
import { toHarnessConfig } from './HarnessDriver';

/** What a version that could not be read is recorded as (plan Call 13). */
export const UNKNOWN_CLI_VERSION = 'unknown';

/**
 * The CLI version each harness runs, asked of its health probe once per
 * what it launches as (plan Call 13). Keyed like `HarnessCapabilitiesCache`,
 * by the driver and the launch description, never the record id, so an
 * edited harness asks again with nothing to invalidate. A probe that fails
 * or reports no version answers `unknown`, and is not remembered: the next
 * ask tries again.
 */
export class HarnessVersions {
  private readonly settled = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(
    private readonly probe: (fields: HarnessLaunchFields) => Promise<HarnessProbeResult>,
  ) {}

  public get(fields: HarnessLaunchFields): Promise<string> {
    const key = versionKey(fields);
    const settled = this.settled.get(key);
    if (settled !== undefined) return Promise.resolve(settled);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const asked = this.ask(fields, key);
    this.pending.set(key, asked);
    return asked;
  }

  /** The version already read for `fields`, or undefined. Starts nothing. */
  public peek(fields: HarnessLaunchFields): string | undefined {
    return this.settled.get(versionKey(fields));
  }

  private async ask(fields: HarnessLaunchFields, key: string): Promise<string> {
    try {
      const result = await this.probe(fields);
      if (!result.available || !result.version) return UNKNOWN_CLI_VERSION;
      this.settled.set(key, result.version);
      return result.version;
    } catch {
      return UNKNOWN_CLI_VERSION;
    } finally {
      this.pending.delete(key);
    }
  }
}

/** A harness by what it launches: its driver, binary and profile; its extra args change no version. */
function versionKey(fields: HarnessLaunchFields): string {
  const config = toHarnessConfig(fields);
  return JSON.stringify([
    fields.driverId ?? 'claude',
    config.binaryPath ?? '',
    config.configDir ?? '',
  ]);
}
