/**
 * The info panel's sections, in the one order they are drawn: Environment,
 * Branch, then Pull request. A section a later design adds is appended here,
 * and its fold state is kept under its id (`settingsStore.infoSectionOpen`).
 */
export type InfoSectionId = 'environment' | 'branch' | 'pull-request';

export const INFO_SECTION_IDS: readonly InfoSectionId[] = ['environment', 'branch', 'pull-request'];
