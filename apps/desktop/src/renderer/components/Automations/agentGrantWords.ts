/*
 * What an agent step's servers and skills grant, in the words the cards, the
 * pipeline and the step detail use. A whole server brings every tool it has,
 * write tools with it, so its line says so, and names those tools when they
 * are known (`knownTools`): the Allow card's from the last answer its
 * harness's CLI gave (main fills them in), the approval card's from the run's
 * definition, which kept the answer the run was made with (review S1).
 */

type Server = { name: string; tools?: readonly string[]; knownTools?: readonly string[] };

/** The most tool names a line lists before saying how many more. */
const LISTED_TOOLS = 10;

/** `a`, `a and b`, `a, b and c`. */
function joined(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** At most ten names, `, `-joined, then `and <n> more`. */
function listed(names: readonly string[]): string {
  if (names.length <= LISTED_TOOLS) return names.join(', ');
  return `${names.slice(0, LISTED_TOOLS).join(', ')} and ${names.length - LISTED_TOOLS} more`;
}

/**
 * One server and what it grants: a narrowed server its tools only; a whole
 * one all its tools, naming them when the last probe listed them.
 */
export function serverGrantLine(server: Server): string {
  if (server.tools !== undefined) return `${server.name}: ${joined(server.tools)} only`;
  const known =
    server.knownTools !== undefined && server.knownTools.length > 0
      ? ` (${listed(server.knownTools)})`
      : '';
  return `${server.name}: all its tools${known}, including any that post or change things`;
}

/** `Skills: a, b`, each by its folder name; null for none. */
export function skillsLine(skills: readonly string[]): string | null {
  return skills.length > 0 ? `Skills: ${skills.join(', ')}` : null;
}

/** Said once on a card whose runs carry an item: what the agent reads is someone else's. */
export const ITEM_TEXT_LINE = 'This agent reads text other people wrote, with these tools at hand.';

/** `claude.ai Coralogix · grafana (query_logs)`: the step detail's servers; null for none. */
export function serversFact(servers: ReadonlyArray<Server>): string | null {
  if (servers.length === 0) return null;
  return servers
    .map((server) =>
      server.tools !== undefined ? `${server.name} (${server.tools.join(', ')})` : server.name,
    )
    .join(' · ');
}

/** `incident-triage, release-notes`: the step detail's skills; null for none. */
export function skillsFact(skills: readonly string[]): string | null {
  return skills.length > 0 ? skills.join(', ') : null;
}

/** The node's third line (review S3): its servers, then `skills: …`, joined by ` · `; null for neither. */
export function nodeGrantsLine(step: {
  servers?: ReadonlyArray<Server>;
  skills?: readonly string[];
}): string | null {
  const parts = [serversFact(step.servers ?? [])];
  const skills = skillsFact(step.skills ?? []);
  if (skills !== null) parts.push(`skills: ${skills}`);
  const shown = parts.filter((part): part is string => part !== null);
  return shown.length > 0 ? shown.join(' · ') : null;
}

const hasServers = (servers: readonly unknown[] | undefined) => (servers?.length ?? 0) > 0;

/** `Agent, read-only`, or `Agent, read-only but for its servers` when its agent names any (review S2). */
export function agentStepHead(servers: readonly unknown[] | undefined): string {
  return hasServers(servers) ? 'Agent, read-only but for its servers' : 'Agent, read-only';
}

/** `Read-only, in a session of its own`, or `Read-only but for its servers, in a session of its own`. */
export function agentStepFoot(servers: readonly unknown[] | undefined): string {
  return hasServers(servers)
    ? 'Read-only but for its servers, in a session of its own'
    : 'Read-only, in a session of its own';
}
