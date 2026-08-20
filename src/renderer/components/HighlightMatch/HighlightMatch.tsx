import { fuzzyMatch } from '../CommandPalette/fuzzyMatch';

interface HighlightMatchProps {
  label: string;
  query: string;
}

/**
 * Bold the characters the query actually matched.
 *
 * Shared by the command palette and the composer's inline menu so both show a
 * match the same way — the highlight has to agree with the ranking, and they
 * agree by calling the same matcher.
 *
 * Emits one element per character, so it must never be a direct child of a
 * flex or grid container: the gap would land between every letter. Wrap it in
 * an inline box of its own.
 */
export function HighlightMatch({ label, query }: HighlightMatchProps) {
  const match = query.trim() ? fuzzyMatch(query.trim(), label) : null;
  if (!match || match.indices.length === 0) return <>{label}</>;

  const matched = new Set(match.indices);
  return (
    <>
      {label.split('').map((char, index) =>
        matched.has(index) ? (
          <mark key={index} className="command-palette-match">
            {char}
          </mark>
        ) : (
          <span key={index}>{char}</span>
        )
      )}
    </>
  );
}
