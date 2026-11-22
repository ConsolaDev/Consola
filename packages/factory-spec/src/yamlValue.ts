import type { Document } from 'yaml';

/**
 * How far one YAML file's aliases (`*name`) may expand when it is read:
 * `yaml`'s own measure (each use of an alias, weighted by the aliases inside
 * what it names), set here so every reader of a factory file has the same
 * cap. Past it the library throws rather than build an exponentially large
 * value; the file is then an issue, never an exception out of a parser.
 * Internal.
 */
export const MAX_YAML_ALIASES = 100;

export const TOO_MANY_ALIASES =
  'This file uses YAML aliases (`*name`) more than Consola reads: write the values out.';

/** What `yaml` throws when a document's aliases expand past the cap. */
const ALIAS_LIMIT = /Excessive alias count/;

/**
 * A parsed document's value, or why it cannot be had: aliases that expand
 * past `MAX_YAML_ALIASES`, or anything else turning it into a value throws.
 * Never throws. Internal: every factory reader takes a document's value here.
 */
export function documentValue(
  doc: Document,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: MAX_YAML_ALIASES }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (ALIAS_LIMIT.test(reason)) return { ok: false, message: TOO_MANY_ALIASES };
    return {
      ok: false,
      message: `This file's YAML cannot be read: ${reason.split('\n')[0].trim()}.`,
    };
  }
}
