/**
 * The two short strings a session row uses to say how it runs: which harness
 * (its initials, worn in the harness's accent colour) and which model (a
 * name a person says out loud, not the API id). Both sit on the row's meta
 * line, which is 11px tall and shared with the row's age, so each has to be
 * a few characters at most. The full forms stay in the tooltip.
 */

/**
 * "Claude - Work" -> "CW", "Claude Personal" -> "CP", "Codex" -> "C".
 *
 * The first letter of the first two words. Separators a person types between
 * words (spaces, dashes, underscores, dots, slashes) all count as breaks, so
 * "claude-work" and "Claude · Work" agree with "Claude - Work".
 */
export function harnessInitials(name: string): string {
  const words = name
    .split(/[\s\-_.·/|:]+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('')
    .toUpperCase();
}

const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku']);

const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh|max)$/i;

const ORCHESTRATOR_LABELS: Record<string, string> = {
  neon: 'Neon',
  carbon: 'Carbon',
  argon: 'Argon',
  'g1-pro': 'Argon',
};

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * "claude-opus-4-6" -> "Opus 4.6", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5",
 * "opus[1m]" -> "Opus 1M", "gpt-5.1-codex" -> "GPT-5.1 Codex",
 * "gemini-4-neon-xhigh" -> "Gemini 4 Neon".
 *
 * Anything it does not recognise comes back unchanged: a model id is the
 * CLI's to define, and an odd one shown whole beats a known one guessed at.
 */
export function shortModelName(model: string): string {
  const id = model.trim();
  const longContext = /\[1m\]$/i.test(id);
  const bare = id.replace(/\[1m\]$/i, '');
  const suffix = longContext ? ' 1M' : '';

  // An alias the CLI accepts on its own: "opus", "sonnet[1m]".
  if (CLAUDE_FAMILIES.has(bare.toLowerCase())) return `${capitalise(bare.toLowerCase())}${suffix}`;

  // Current ids: family first, then the version, then an optional date or effort level.
  const current =
    /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8}|-(?:low|medium|high|xhigh|max))?$/i.exec(
      bare,
    );
  if (current) {
    const [, family, major, minor] = current;
    return `${capitalise(family.toLowerCase())} ${major}${minor ? `.${minor}` : ''}${suffix}`;
  }

  // Older ids put the version first: "claude-3-5-sonnet-20241022".
  const legacy = /^claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(bare);
  if (legacy) {
    const [, major, minor, family] = legacy;
    return `${capitalise(family.toLowerCase())} ${major}${minor ? `.${minor}` : ''}${suffix}`;
  }

  // Antigravity Orchestrator ids: "gemini-pro-orchestrator-neon" -> "Orchestrator (Neon)".
  const orchestrator = /^gemini-pro-orchestrator-([a-z0-9-]+)$/i.exec(bare);
  if (orchestrator) {
    const key = orchestrator[1].toLowerCase();
    const variant = ORCHESTRATOR_LABELS[key] ?? capitalise(key);
    return `Orchestrator (${variant})${suffix}`;
  }

  // Antigravity Gemini ids: "gemini-4-neon-xhigh" -> "Gemini 4 Neon",
  // "gemini-3.8-flash-high" -> "Gemini 3.8 Flash".
  const gemini = /^gemini-([\d.]+)-([a-z0-9-]+)$/i.exec(bare);
  if (gemini) {
    const [, version, rest] = gemini;
    const withoutEffort = rest.replace(EFFORT_SUFFIX, '');
    const variants = withoutEffort.split('-').filter(Boolean).map(capitalise);
    return [`Gemini ${version}`, ...variants].join(' ') + suffix;
  }

  // "gpt-oss-120b-medium" -> "GPT-OSS 120B".
  const gptOss = /^gpt-oss-(\d+[a-z]?)(?:-(?:low|medium|high|xhigh|max))?$/i.exec(bare);
  if (gptOss) {
    return `GPT-OSS ${gptOss[1].toUpperCase()}${suffix}`;
  }

  // "gpt-5.1-codex-max" -> "GPT-5.1 Codex Max": the version stays glued to
  // its family, the variants after it read as words.
  const gpt = /^gpt-([\d.]+[a-z]?)((?:-[a-z0-9]+)*)$/i.exec(bare);
  if (gpt) {
    const [, version, rest] = gpt;
    const variants = rest.split('-').filter(Boolean).map(capitalise);
    return [`GPT-${version}`, ...variants].join(' ') + suffix;
  }

  return id;
}
