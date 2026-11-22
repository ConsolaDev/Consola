/**
 * The dashboard's sections, as the address names them. A section is `#/<id>`, an id being
 * lowercase letters, digits and single dashes. Whatever follows the id in the hash, after a `/`
 * or a `?`, is the section's own and never changes which section it is. The query string before
 * the hash is never read here: a page that is sent back with a result there (`?github=…`) reads
 * and clears it itself.
 */

const SECTION_HASH = /^#\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[/?].*)?$/s;

/** The section a hash names (`#/teams`, `#/teams?x`, `#/teams/x`), or null when it names none. */
export function sectionIdOfHash(hash: string): string | null {
  return SECTION_HASH.exec(hash)?.[1] ?? null;
}

/** The hash that opens the section `id`. */
export function hashOfSection(id: string): string {
  return `#/${id}`;
}

/**
 * The section to show: the one `wanted` names when it is listed, else the first, so an address
 * that names no section, or one this build does not have, opens the first.
 */
export function chooseSection<Section extends { id: string }>(
  sections: readonly [Section, ...Section[]],
  wanted: string | null,
): Section {
  return sections.find((section) => section.id === wanted) ?? sections[0];
}
