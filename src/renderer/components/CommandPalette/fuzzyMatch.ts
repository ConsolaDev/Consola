/**
 * Subsequence matching for the command palette.
 *
 * Kept dependency-free and deliberately simple: every list the palette
 * searches is a few hundred short strings at most, so a single greedy pass per
 * candidate is far cheaper than the machinery a real fuzzy library brings.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices in the searched text that matched, for highlighting. */
  indices: number[];
}

/** Characters that start a new "word" for scoring purposes. */
const WORD_BOUNDARY = /[\s\-_/\\.]/;

/**
 * Match `query` against `text`, case-insensitively.
 *
 * Returns null unless every character of the query appears in order. Matches
 * that are contiguous, land on word boundaries, or hit camelCase humps score
 * higher, so typing "gcm" finds "Generate commit message" ahead of an
 * incidental scattered hit in a longer string.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, indices: [] };

  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();

  const indices: number[] = [];
  let score = 0;
  let queryIndex = 0;
  let lastMatch = -1;

  for (let i = 0; i < haystack.length && queryIndex < needle.length; i++) {
    if (haystack[i] !== needle[queryIndex]) continue;

    const isConsecutive = lastMatch === i - 1;
    const previous = i > 0 ? text[i - 1] : '';
    const isBoundary = i === 0 || WORD_BOUNDARY.test(previous);
    const isCamelHump = i > 0 && /[a-z0-9]/.test(previous) && /[A-Z]/.test(text[i]);

    let charScore = 1;
    if (isConsecutive) charScore += 8;
    if (isBoundary) charScore += 6;
    if (isCamelHump) charScore += 4;
    if (lastMatch >= 0 && !isConsecutive) {
      charScore -= Math.min(4, i - lastMatch - 1);
    }

    score += charScore;
    indices.push(i);
    lastMatch = i;
    queryIndex++;
  }

  if (queryIndex < needle.length) return null;

  // Between two similar matches, prefer the shorter, more specific label.
  score += Math.max(0, 20 - haystack.length) * 0.1;

  return { score, indices };
}

/**
 * Rank an item by its label, falling back to its secondary context.
 *
 * A session's workspace name is searchable so typing a project name surfaces
 * its conversations, but it scores below a direct label hit — a session
 * actually called "console" should outrank every session that merely lives in
 * a workspace of that name. The context match reports no indices, since the
 * highlight only ever renders over the label.
 *
 * Context is matched as a substring rather than a subsequence. Contexts are
 * long — a full filesystem path — and against those a subsequence matches
 * almost any short query, which turned "sess" into a hit on
 * "/Users/dev/notes". Requiring a contiguous run keeps the fallback useful
 * without letting it drown the real matches.
 */
export function rankItem(query: string, label: string, context?: string): FuzzyMatch | null {
  const primary = fuzzyMatch(query, label);
  if (!context) return primary;

  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return primary ?? { score: 0, indices: [] };

  const at = context.toLowerCase().indexOf(needle);
  if (at === -1) return primary;

  // Earlier hits score higher; the whole context match stays below a label hit.
  const contextMatch: FuzzyMatch = { score: Math.max(1, 30 - at), indices: [] };
  if (!primary) return contextMatch;
  return primary.score >= contextMatch.score ? primary : contextMatch;
}
