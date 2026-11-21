const REPOSITORY = 'https://github.com/ConsolaDev/Consola';

/** Where the running code's source is (AGPL §13); the repository itself when the commit is unknown. */
export function sourceUrl(commit: string): string {
  return commit === '' ? REPOSITORY : `${REPOSITORY}/tree/${commit}`;
}
