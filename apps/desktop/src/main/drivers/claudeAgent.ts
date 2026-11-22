import * as os from 'node:os';
import type { ClaudeAgentGrants } from '../../shared/agentGrants';
import { CONSOLA_MCP_SERVER } from '../mcp/names';
import { type ControlRequest, INITIALIZE, requestControl } from './claudeCapabilities';
import { CLAUDE_SIGN_IN_HINT } from './claudeTurnReader';
import type { CompileAgentInput, CompiledAgent, McpServerReport } from './HarnessDriver';

/**
 * A step's agent on Claude: which MCP servers a harness has, asked of its
 * CLI over the control protocol (`mcp_status`, as canary row 20 checked on
 * 2.1.330).
 *
 * The answer is the CLI's own wire format, not a promised contract, so it
 * is read strictly: an unrecognised shape throws rather than reading as "this
 * harness has no servers". Of each server's config only its type and URL
 * are kept; the command, its arguments, headers and ids are dropped unread.
 */

/** The control request whose answer lists the servers this process connected to. */
export const MCP_STATUS: ControlRequest = {
  requestId: 'consola-mcp-status',
  request: { subtype: 'mcp_status' },
};

/**
 * The probe's flags, after the handshake's and before `--mcp-config <account
 * file>`: `--restricted` keeps the folder's servers, plugins and settings out,
 * so the answer lists the profile's user servers and claude.ai connectors
 * only; the rest keeps the process from doing anything but connect.
 */
export const PROBE_FLAGS: readonly string[] = [
  '--restricted',
  '--permission-mode',
  'dontAsk',
  '--tools',
  'Read',
];

/** How the probe waits: asked every half second, for 20 s, then whatever it has; 30 s in all. */
const PROBE_EVERY_MS = 500;
const PROBE_FOR_MS = 20_000;
const PROBE_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The CLI's `scope` for a server, as where it comes from. */
function sourceOf(name: string, scope: unknown): McpServerReport['source'] {
  if (scope === 'dynamic') return 'user';
  if (scope === 'claudeai') return 'connector';
  if (name.startsWith('plugin:')) return 'plugin';
  return 'other';
}

const TRANSPORTS: ReadonlySet<string> = new Set(['stdio', 'http', 'sse', 'claudeai-proxy']);

function transportOf(type: unknown): McpServerReport['transport'] {
  return typeof type === 'string' && TRANSPORTS.has(type)
    ? (type as McpServerReport['transport'])
    : 'other';
}

function toolsOf(server: string, tools: unknown[]): string[] {
  return tools.map((tool) => {
    if (typeof tool === 'string') return tool;
    if (isObject(tool) && typeof tool.name === 'string') return tool.name;
    throw new Error(`The CLI listed a tool of \`${server}\` it does not recognise.`);
  });
}

/**
 * The `mcp_status` answer as a report: per server its name, source (from
 * `scope`), transport (from `config.type`), URL (`config.url`), tools and
 * status, with Claude's sign-in hint. Nothing else of `config` is read.
 * Throws on a shape it does not recognise.
 */
export function mapMcpStatus(raw: unknown): McpServerReport[] {
  if (!isObject(raw)) {
    throw new Error('The CLI answered mcp_status with something other than an object.');
  }
  if (!Array.isArray(raw.mcpServers)) {
    throw new Error('The CLI answered mcp_status without a server list.');
  }
  return raw.mcpServers.map((server): McpServerReport => {
    if (!isObject(server) || typeof server.name !== 'string' || typeof server.status !== 'string') {
      throw new Error('The CLI listed an MCP server it does not recognise.');
    }
    const config = isObject(server.config) ? server.config : {};
    return {
      name: server.name,
      source: sourceOf(server.name, server.scope),
      transport: transportOf(config.type),
      ...(typeof config.url === 'string' ? { url: config.url } : {}),
      ...(Array.isArray(server.tools) ? { tools: toolsOf(server.name, server.tools) } : {}),
      status: server.status,
      signInHint: CLAUDE_SIGN_IN_HINT,
    };
  });
}

/** Whether an `mcp_status` answer still has a server connecting; an unrecognised one has none to wait for. */
function stillPending(answer: unknown): boolean {
  return (
    isObject(answer) &&
    Array.isArray(answer.mcpServers) &&
    answer.mcpServers.some((server) => isObject(server) && server.status === 'pending')
  );
}

/**
 * Ask a Claude CLI which MCP servers it would connect to: one process, from
 * the home folder (no checkout's files are near it), `initialize` then
 * `mcp_status` until no server is `pending` or `forMs` passes (a server
 * still pending then stays so in the report). With `accountFile`, the
 * profile's user servers load from it (`--mcp-config`); without, only its
 * connectors are there to report. Rejects when the CLI cannot be asked.
 */
export async function probeClaudeMcpServers(
  binary: string,
  env: NodeJS.ProcessEnv,
  accountFile: string | null,
  {
    everyMs = PROBE_EVERY_MS,
    forMs = PROBE_FOR_MS,
    timeoutMs = PROBE_TIMEOUT_MS,
  }: { everyMs?: number; forMs?: number; timeoutMs?: number } = {},
): Promise<McpServerReport[]> {
  const [, status] = await requestControl(binary, os.homedir(), env, [INITIALIZE, MCP_STATUS], {
    timeoutMs,
    extraArgs: [...PROBE_FLAGS, ...(accountFile ? ['--mcp-config', accountFile] : [])],
    repeat: { until: (answer) => !stillPending(answer), everyMs, forMs },
  });
  return mapMcpStatus(status);
}

// ---------------------------------------------------------------------------
// Compiling an agent into grants

/** The one plugin Consola builds for a step; its skills are `consola-step:<name>`. */
const CONSOLA_STEP_PLUGIN = 'consola-step';

/**
 * Characters Claude keeps in a server's or tool's name in permission rules
 * (`mcp__<server>__<tool>`): every other one becomes `_` (canary rows 22 and
 * 23 saw it on 2.1.330).
 */
const KEPT_IN_RULES = /[^A-Za-z0-9_-]/g;

/**
 * The only names `allowedMcpServers` can keep a server by (`serverName`): on
 * 2.1.330 a stdio server named with anything else is blocked whatever the
 * allow-list says (canary row 22, the conductor's ruling of 2026-11-22), so
 * one is refused at compile rather than granted and never loaded.
 */
const KEPT_BY_NAME = /^[A-Za-z0-9_-]+$/;

/** How many names a refusal lists before it says how many more. */
const MAX_LISTED = 10;

/** Claude's name for a server or tool in permission rules: every character outside [A-Za-z0-9_-] as `_`. */
export function flattenedName(name: string): string {
  return name.replace(KEPT_IN_RULES, '_');
}

/** `a, b, c` (at most ten, then `and <n> more`), or `none`. */
export function listedNames(names: readonly string[]): string {
  if (names.length === 0) return 'none';
  const shown = names.slice(0, MAX_LISTED).join(', ');
  return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown;
}

/** `(it has: a, b)`, or `(it has none)`. */
function itHas(names: readonly string[]): string {
  return names.length === 0 ? '(it has none)' : `(it has: ${listedNames(names)})`;
}

/** Whether Claude keeps this server by `serverName` (stdio) rather than by `serverUrl`. */
function keptByName(server: McpServerReport): boolean {
  return server.transport === 'stdio';
}

/** Whether Consola cannot write an allow-list entry for this server, so cannot limit it. */
function unrecognised(server: McpServerReport): boolean {
  if (server.source === 'other' || server.transport === 'other') return true;
  // A remote server or a connector is kept by its URL, so it needs one.
  return (server.source === 'connector' || !keptByName(server)) && server.url === undefined;
}

/**
 * Whether a step may run this agent on Claude, and its grants: for each
 * server in the agent's order, Consola's own name, a plugin's, a name the
 * report lacks, a source or transport it does not know, the person's own
 * server on an item step, a stdio name the allow-list cannot keep, then an
 * unknown narrowed tool; then, across the granted servers, two names that
 * read as one and the profile's own `consola`. The first refusal is the
 * answer. Warnings, in the agent's order: a server that was not connected,
 * then a narrowing that could not be checked. Pure.
 */
export function compileClaudeAgent(
  input: CompileAgentInput & { accountFile: string },
): CompiledAgent {
  const { harnessName, agent, checkout, servers, accountFile } = input;
  const reported = new Map<string, McpServerReport>();
  for (const server of servers) if (!reported.has(server.name)) reported.set(server.name, server);
  const granted: McpServerReport[] = [];
  const warnings: string[] = [];

  for (const wanted of agent.mcpServers) {
    const { name } = wanted;
    if (flattenedName(name) === CONSOLA_MCP_SERVER) {
      return refused(`\`${name}\` is Consola's own server's name; rename it in ${harnessName}.`);
    }
    if (name.startsWith('plugin:')) {
      return refused(
        `\`${name}\` comes from a plugin, which would bring its hooks and skills too. Add the server itself as a user server in ${harnessName}; it will need its own sign-in, since a sign-in belongs to a server's name.`,
      );
    }
    const server = reported.get(name);
    if (!server) {
      return refused(
        `\`${name}\` isn't one of ${harnessName}'s MCP servers ${itHas([...reported.keys()])}. Add it with \`claude mcp add --scope user\`, or fix the name.`,
      );
    }
    if (unrecognised(server)) {
      return refused(
        `Consola doesn't know how ${harnessName} loads \`${name}\` (source: ${server.source}, transport: ${server.transport}), so it can't limit it.`,
      );
    }
    if (server.source === 'user' && checkout === 'item') {
      return refused(
        `\`${name}\` comes from ${harnessName}'s own settings, and a step on someone else's pull request or issue starts it, or a helper command it runs for its sign-in, inside the author's checkout, where \`npx\`, \`uvx\` or a relative path can run the author's code. On item steps, use a claude.ai connector; this server works in scheduled steps.`,
      );
    }
    if (keptByName(server) && !KEPT_BY_NAME.test(name)) {
      return refused(
        `\`${name}\` can't be kept by name in Claude's allow-list, which takes only ASCII letters, digits, \`_\` and \`-\`, so a step could never load it; rename it in ${harnessName}.`,
      );
    }
    if (wanted.tools && server.tools) {
      const missing = wanted.tools.find((tool) => !server.tools!.includes(tool));
      if (missing !== undefined) {
        return refused(`\`${name}\` has no tool \`${missing}\` ${itHas(server.tools)}.`);
      }
    }
    if (server.status === 'needs-auth') {
      warnings.push(
        `\`${name}\` needs you to sign in again in ${harnessName}: ${CLAUDE_SIGN_IN_HINT}.`,
      );
    } else if (server.status !== 'connected') {
      warnings.push(
        `\`${name}\` was ${server.status} when Consola asked ${harnessName} (${CLAUDE_SIGN_IN_HINT}); a step that uses it fails until it connects.`,
      );
    }
    if (wanted.tools && !server.tools) {
      warnings.push(
        `\`${name}\` was not connected when Consola asked ${harnessName}, so its tool names could not be checked; a name it does not have grants nothing.`,
      );
    }
    granted.push(server);
  }

  for (let i = 0; i < granted.length; i++) {
    for (let j = i + 1; j < granted.length; j++) {
      const flattened = flattenedName(granted[i].name);
      if (flattened === flattenedName(granted[j].name)) {
        return refused(
          `\`${granted[i].name}\` and \`${granted[j].name}\` read as one name to Claude (\`mcp__${flattened}__\`); rename one in ${harnessName}.`,
        );
      }
    }
  }
  const loadsAccountFile = granted.some((server) => server.source === 'user');
  const ownConsola = servers.some(
    (server) => server.source === 'user' && flattenedName(server.name) === CONSOLA_MCP_SERVER,
  );
  if (loadsAccountFile && ownConsola) {
    return refused(
      `${harnessName} has a server of its own named \`${CONSOLA_MCP_SERVER}\`, which is Consola's own server's name, so a step can't load ${harnessName}'s own servers beside it; rename it in ${harnessName}.`,
    );
  }

  const allowedTools: string[] = [];
  for (const wanted of agent.mcpServers) {
    const server = flattenedName(wanted.name);
    if (wanted.tools) {
      for (const tool of wanted.tools) allowedTools.push(`mcp__${server}__${flattenedName(tool)}`);
    } else allowedTools.push(`mcp__${server}__*`);
  }
  for (const skill of agent.skills) allowedTools.push(`Skill(${CONSOLA_STEP_PLUGIN}:${skill})`);

  const grants: ClaudeAgentGrants = {
    driverId: 'claude',
    servers: agent.mcpServers.map((wanted) => ({
      name: wanted.name,
      ...(wanted.tools ? { tools: [...wanted.tools] } : {}),
    })),
    skills: [...agent.skills],
    ...(granted.length > 0
      ? {
          allowedMcpServers: [
            { serverName: CONSOLA_MCP_SERVER },
            ...granted.map((server) =>
              keptByName(server) ? { serverName: server.name } : { serverUrl: server.url! },
            ),
          ],
        }
      : {}),
    strict: !granted.some((server) => server.source === 'connector'),
    ...(loadsAccountFile ? { accountFile } : {}),
    allowedTools,
    ...(agent.skills.length > 0 && input.pluginDir !== undefined
      ? { pluginDir: input.pluginDir }
      : {}),
  };
  return { ok: true, grants, warnings };
}

function refused(problem: string): CompiledAgent {
  return { ok: false, problem };
}
