/**
 * What a checker reported against what is known, by count: a known error listed once that appears
 * twice has one occurrence unexpected, and one listed twice that appears once has one gone.
 */
export const compareErrors = (
  found: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
): { unexpected: string[]; gone: string[] } => {
  const remaining = new Map<string, number>();
  for (const error of known) remaining.set(error, (remaining.get(error) ?? 0) + 1);
  const unexpected: string[] = [];
  for (const error of found) {
    const left = remaining.get(error) ?? 0;
    if (left === 0) unexpected.push(error);
    else remaining.set(error, left - 1);
  }
  const gone: string[] = [];
  for (const [error, left] of remaining) for (let i = 0; i < left; i++) gone.push(error);
  return { unexpected, gone };
};
