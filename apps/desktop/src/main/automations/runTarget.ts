import type { ItemTarget } from '../../shared/automations';

/**
 * A run target from the renderer, checked before main acts on it: exactly one
 * of a work item (repo, a positive integer number, `pr` or `issue`), a poll
 * item's key, or a URL. Anything else, including null or a string, is refused,
 * so the runner only ever sees a well-formed one.
 */
export function asRunTarget(value: unknown): ItemTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Not a run target.');
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 1) throw new Error('Not a run target.');
  if (keys[0] === 'key' && typeof fields.key === 'string' && fields.key !== '')
    return { key: fields.key };
  if (keys[0] === 'url' && typeof fields.url === 'string' && fields.url !== '')
    return { url: fields.url };
  if (keys[0] === 'workItem' && typeof fields.workItem === 'object' && fields.workItem !== null) {
    const item = fields.workItem as Record<string, unknown>;
    if (
      typeof item.repo === 'string' &&
      item.repo !== '' &&
      typeof item.number === 'number' &&
      Number.isInteger(item.number) &&
      item.number > 0 &&
      (item.type === 'pr' || item.type === 'issue')
    ) {
      return { workItem: { repo: item.repo, number: item.number, type: item.type } };
    }
  }
  throw new Error('Not a run target.');
}
