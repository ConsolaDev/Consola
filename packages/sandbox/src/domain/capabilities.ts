/**
 * What a provider can do beyond the basics (create, run, files, ports, stop, and reaching a
 * sandbox by its id). A provider declares one by having the member of that name; code checks
 * for the member, and never asks which provider it has.
 *
 * - `pausing`: a sandbox can be paused, keeping its files at little cost, and resumed later by
 *   its id, from any process.
 * - `snapshots`: a sandbox's files can be saved as a template that new sandboxes start from,
 *   and the template removed once it is no longer needed.
 * - `keepAlive`: a running sandbox's lifetime can be renewed, so work that runs for long keeps
 *   its sandbox while whoever started it is alive, and loses it soon after that dies.
 */
export const SANDBOX_CAPABILITIES = ['pausing', 'snapshots', 'keepAlive'] as const;

export type SandboxCapability = (typeof SANDBOX_CAPABILITIES)[number];

/** What each capability lets code do, worded to finish "This sandbox provider cannot …". */
export const CAPABILITY_ABILITIES: Readonly<Record<SandboxCapability, string>> = {
  pausing: 'pause and resume sandboxes',
  snapshots: 'save a sandbox as a snapshot',
  keepAlive: "renew a sandbox's lifetime",
};
