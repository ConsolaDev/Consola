import { execFile } from 'node:child_process';
import type {
  HarnessAgent,
  HarnessCapabilities,
  HarnessCommand,
  HarnessModel,
} from '../../shared/types';

/**
 * Asking `agy` what models, slash commands, skills and custom agents it offers.
 *
 * Every query runs from the home directory with zero model turns and zero
 * persisted conversations:
 * - `agy models` prints tab-separated `<slug>\t<displayName>` lines.
 * - `agy -p /help --output-format json` returns built-in slash commands.
 * - `agy -p /skills --output-format json` returns invocable skills.
 * - `agy -p /agents --output-format json` returns custom agents.
 *
 * Parsing is strict: an unrecognised model response throws rather than
 * returning an empty list that would look like "no models available".
 */

const PROBE_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string;
}

function runCommand(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout,
          stderr,
          code: error ? String((error as NodeJS.ErrnoException).code ?? '') : undefined,
        });
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse `agy models` output (`<slug>\t<displayName>` or column-aligned spaces).
 * Throws when no recognised models are present, rather than inventing an empty list.
 */
export function parseAntigravityModels(stdout: string): HarnessModel[] {
  const models: HarnessModel[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split('\n')) {
    // Strip any carriage-return spinner prefix left on a line.
    const segment = rawLine.split('\r').pop()?.trim() ?? '';
    if (!segment) continue;

    let value: string;
    let displayName: string;
    const tab = segment.indexOf('\t');
    if (tab !== -1) {
      value = segment.slice(0, tab).trim();
      displayName = segment.slice(tab + 1).trim();
    } else {
      const match = /^(\S+)\s{2,}(.+)$/.exec(segment);
      if (!match) continue;
      value = match[1].trim();
      displayName = match[2].trim();
    }

    if (!value || !displayName || /\s/.test(value) || seen.has(value)) continue;
    seen.add(value);
    models.push({
      value,
      resolvedModel: value,
      displayName,
      description: '',
    });
  }

  if (models.length === 0) {
    throw new Error(
      'Invalid model response from Antigravity. Check the CLI version and try again.',
    );
  }
  return models;
}

/** Parse the JSON envelope printed by `agy -p /<cmd> --output-format json`. */
function parseCommandData(stdout: string, expectedName: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.status !== 'SUCCESS') return null;
  const command = parsed.command;
  if (!isRecord(command) || command.name !== expectedName || !isRecord(command.data)) return null;
  return command.data;
}

export function parseAntigravityHelpCommands(stdout: string): HarnessCommand[] {
  const data = parseCommandData(stdout, 'help');
  if (!data || !Array.isArray(data.commands)) {
    throw new Error('Invalid command response from Antigravity.');
  }
  const commands: HarnessCommand[] = [];
  for (const raw of data.commands) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name)?.replace(/^\/+/, '');
    if (!name) continue;
    commands.push({
      name,
      description: asString(raw.description) ?? '',
      aliases: asStringArray(raw.aliases),
    });
  }
  return commands;
}

export function parseAntigravitySkills(stdout: string): HarnessCommand[] {
  const data = parseCommandData(stdout, 'skills');
  if (!data || !Array.isArray(data.skills)) {
    throw new Error('Invalid skills response from Antigravity.');
  }
  const skills: HarnessCommand[] = [];
  for (const raw of data.skills) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name)?.replace(/^\/+/, '');
    if (!name) continue;
    skills.push({
      name,
      description: asString(raw.description) ?? '',
    });
  }
  return skills;
}

export function parseAntigravityAgents(stdout: string): HarnessAgent[] {
  const data = parseCommandData(stdout, 'agents');
  if (!data || !Array.isArray(data.agents)) {
    throw new Error('Invalid agents response from Antigravity.');
  }
  const agents: HarnessAgent[] = [];
  for (const raw of data.agents) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name);
    if (!name) continue;
    agents.push({
      name,
      description: asString(raw.description) ?? '',
    });
  }
  return agents;
}

function mergeCommands(primary: HarnessCommand[], secondary: HarnessCommand[]): HarnessCommand[] {
  const seen = new Set<string>();
  const merged: HarnessCommand[] = [];
  for (const command of [...primary, ...secondary]) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    merged.push(command);
  }
  return merged;
}

export async function probeAntigravityCapabilities(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HarnessCapabilities> {
  const [modelsRes, helpRes, skillsRes, agentsRes] = await Promise.all([
    runCommand(binary, ['models'], cwd, env, timeoutMs),
    runCommand(binary, ['-p', '/help', '--output-format', 'json'], cwd, env, timeoutMs),
    runCommand(binary, ['-p', '/skills', '--output-format', 'json'], cwd, env, timeoutMs),
    runCommand(binary, ['-p', '/agents', '--output-format', 'json'], cwd, env, timeoutMs),
  ]);

  if (!modelsRes.ok) {
    if (modelsRes.code === 'ENOENT') {
      throw new Error('Not found — `agy` is not installed or not on PATH.');
    }
    if (/sign in|authentication required/i.test(modelsRes.stderr + modelsRes.stdout)) {
      throw new Error('Not signed in — run `agy` in a terminal to authenticate.');
    }
    throw new Error('Could not load Antigravity models. Check the binary path and sign-in status.');
  }

  const models = parseAntigravityModels(modelsRes.stdout);

  // Slash commands, skills and agents enrich the composer when this CLI build
  // supports JSON command reports; a missing or older report never blocks models.
  let helpCommands: HarnessCommand[] = [];
  if (helpRes.ok) {
    try {
      helpCommands = parseAntigravityHelpCommands(helpRes.stdout);
    } catch {
      /* Ignore unrecognised auxiliary output while models succeeded. */
    }
  }
  let skillCommands: HarnessCommand[] = [];
  if (skillsRes.ok) {
    try {
      skillCommands = parseAntigravitySkills(skillsRes.stdout);
    } catch {
      /* Ignore unrecognised auxiliary output while models succeeded. */
    }
  }
  let agents: HarnessAgent[] = [];
  if (agentsRes.ok) {
    try {
      agents = parseAntigravityAgents(agentsRes.stdout);
    } catch {
      /* Ignore unrecognised auxiliary output while models succeeded. */
    }
  }

  return {
    commands: mergeCommands(helpCommands, skillCommands),
    agents,
    outputStyles: [],
    models,
  };
}
