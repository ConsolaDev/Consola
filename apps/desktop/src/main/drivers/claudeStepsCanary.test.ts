import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { skillHash } from '@consola/factory-spec';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAgentGrants } from '../../shared/agentGrants';
import { ClaudeDriver } from './ClaudeDriver';
import { buildStepPlugin, compileClaudeAgent } from './claudeAgent';
import { denyReadList, fileToolDenyRules } from './claudeWriteAgent';
import type { SessionLaunch } from './HarnessDriver';

// (vi.mock is hoisted above the imports.) The real probe runs the user's interactive login shell.
vi.mock('../LoginEnvironment', () => ({
  getLoginEnv: () => process.env,
  loginEnvProblem: () => null,
}));

/*
 * The real-CLI canary (`scripts/claude-steps-canary.mjs`) writes a step's
 * read-only flags out by hand (`scripts/claude-step-flags.mjs`), since it
 * imports nothing from the app. This keeps that copy equal to what the
 * driver launches a step's turn with, so a change to the driver's flags
 * cannot leave the canary probing the old ones.
 */

const FLAGS = path.resolve(__dirname, '../../../scripts/claude-step-flags.mjs');

type StepFlags = (options?: {
  tools?: string;
  allowed?: string[];
  restricted?: boolean;
}) => string[];

type AgentFlags = (options?: {
  mcpConfig?: string[];
  settings?: Record<string, unknown>;
  pluginDir?: string;
  strict?: boolean;
  tools?: string;
  allowed?: string[];
  deny?: string[];
}) => string[];

/** The names after `--allowedTools`, up to the next flag. */
function allowedOf(flags: string[]): string[] {
  const at = flags.indexOf('--allowedTools');
  const names: string[] = [];
  for (let next = at + 1; next < flags.length && !flags[next].startsWith('--'); next++) {
    names.push(flags[next]);
  }
  return names;
}

/** The flags with the allowed tools' names left out: each canary row allows its own. */
function withoutAllowed(flags: string[]): string[] {
  const at = flags.indexOf('--allowedTools');
  return [...flags.slice(0, at + 1), ...flags.slice(at + 1 + allowedOf(flags).length)];
}

describe('the real-CLI canary', () => {
  it('probes the read-only flags a step’s turn launches with', async () => {
    // A path the compiler does not follow: the script is plain Node, outside `src`.
    const { stepFlags } = (await import(pathToFileURL(FLAGS).href)) as { stepFlags: StepFlags };
    const launched = new ClaudeDriver().buildSessionArgs(
      { extraArgs: [] },
      {
        sessionId: 's1',
        resume: false,
        toolPolicy: 'read-only',
        unattended: true,
        initialPrompt: 'p',
      },
    );
    const policy = launched.slice(
      launched.indexOf('--strict-mcp-config'),
      launched.indexOf('--restricted') + 1,
    );
    const canary = stepFlags();
    expect(policy[0]).toBe('--strict-mcp-config');
    expect(withoutAllowed(canary)).toEqual(withoutAllowed(policy));
    // What the canary allows, a step's turn allows too.
    expect(allowedOf(canary).length).toBeGreaterThan(0);
    expect(allowedOf(policy)).toEqual(expect.arrayContaining(allowedOf(canary)));
  });
});

describe("the real-CLI canary's agent flags", () => {
  const ACCOUNT = '/home/alice/.claude-work/.claude.json';
  const loadAgentFlags = async () =>
    ((await import(pathToFileURL(FLAGS).href)) as { agentFlags: AgentFlags }).agentFlags;
  const turn: SessionLaunch = {
    sessionId: 's1',
    resume: false,
    toolPolicy: 'read-only',
    unattended: true,
    reportTurn: true,
    initialPrompt: 'p',
    mcpConfigPath: '/m/consola.json',
    maxTurns: 40,
    model: 'haiku',
  };
  /** The argv less print mode, the session flags, the model, the report, the cap, `--` and the prompt. */
  const grantsPart = (argv: string[]): string[] => {
    const at = argv.indexOf('--mcp-config');
    const end = argv.indexOf('--restricted') + 1;
    const kept = argv.slice(at, end);
    for (const dropped of [
      ['--output-format', 'stream-json', '--verbose'],
      ['--max-turns', '40'],
    ]) {
      const from = kept.indexOf(dropped[0]);
      expect(kept.slice(from, from + dropped.length)).toEqual(dropped);
      kept.splice(from, dropped.length);
    }
    return kept;
  };
  /** Consola's own tool names, which each canary row allows its own of, left out. */
  const withoutConsolaTools = (flags: string[]) =>
    flags.filter((flag) => !flag.startsWith('mcp__consola__'));

  it("compiles an agent's grants as the canary launches them", async () => {
    const agentFlags = await loadAgentFlags();
    const grants: ClaudeAgentGrants = {
      driverId: 'claude',
      servers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
      skills: [],
      allowedMcpServers: [
        { serverName: 'consola' },
        { serverUrl: 'https://mcp.coralogix.example/mcp' },
        { serverName: 'grafana' },
      ],
      strict: false,
      accountFile: ACCOUNT,
      allowedTools: ['mcp__claude_ai_Coralogix__*', 'mcp__grafana__query_logs'],
    };
    const launched = new ClaudeDriver().buildSessionArgs({ extraArgs: [] }, { ...turn, grants });
    if (!Array.isArray(launched)) throw new Error('expected a plain array');
    expect(withoutConsolaTools(grantsPart(launched))).toEqual(
      withoutConsolaTools(
        agentFlags({
          mcpConfig: ['/m/consola.json', ACCOUNT],
          settings: { allowedMcpServers: grants.allowedMcpServers },
          strict: false,
          allowed: grants.allowedTools,
        }),
      ),
    );
  });

  it("compiles an agent's skills as the canary launches them", async () => {
    const agentFlags = await loadAgentFlags();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-canary-skills-'));
    try {
      const pluginDir = path.join(dir, 'plugin');
      // The plugin as a step's first launch builds it, from the run's copy, to the run's hash (review M1).
      const skillsDir = path.join(dir, 'skills');
      fs.mkdirSync(path.join(skillsDir, 'incident-triage'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'incident-triage', 'SKILL.md'), '# Triage\n');
      const skillHashes = {
        'incident-triage': skillHash([
          { path: 'SKILL.md', bytes: new TextEncoder().encode('# Triage\n') },
        ]),
      };
      await buildStepPlugin(skillsDir, pluginDir, ['incident-triage'], skillHashes);
      const script = path.join(dir, 'cli.cjs');
      fs.writeFileSync(
        script,
        `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success',
    request_id: message.request_id, response: { commands: [{ name: 'dataviz' }, { name: 'consola-step:incident-triage' }] } } }) + '\\n');
});
setTimeout(() => {}, 10000);`,
      );
      const cli = path.join(dir, 'claude');
      fs.writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      fs.chmodSync(cli, 0o755);
      const grants: ClaudeAgentGrants = {
        driverId: 'claude',
        servers: [],
        skills: ['incident-triage'],
        strict: true,
        allowedTools: ['Skill(consola-step:incident-triage)'],
        pluginDir,
        skillHashes,
      };
      const launched = await new ClaudeDriver().buildSessionArgs(
        { binaryPath: cli, extraArgs: [] },
        { ...turn, cwd: dir, grants },
      );
      expect(withoutConsolaTools(grantsPart(launched))).toEqual(
        withoutConsolaTools(
          agentFlags({
            mcpConfig: ['/m/consola.json'],
            pluginDir,
            strict: true,
            tools: 'Read,Grep,Glob,Skill',
            allowed: ['Skill(consola-step:incident-triage)'],
            deny: ['Skill(dataviz)'],
          }),
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the real-CLI canary's write agent flags (slice 3-B Task 17)", () => {
  type WriteAgentFlags = (options: {
    tools: 'edit' | 'write';
    settings?: Record<string, unknown>;
    deny?: string[];
    strict?: boolean;
    pluginDir?: string;
    skills?: string[];
  }) => string[];
  type DenyReadListFor = (input: {
    home: string;
    userData: string;
    factoryRoot: string;
    profiles?: string[];
  }) => string[];
  const load = async () =>
    (await import(pathToFileURL(FLAGS).href)) as {
      writeAgentFlags: WriteAgentFlags;
      denyReadListFor: DenyReadListFor;
    };
  const CHECKOUT = '/w/catalog-portal-run-3f2a91c0';
  const DENY = ['/h/Library/Keychains', '/h/.claude-work'];
  const grantsFor = (tools: 'edit' | 'write', isolation: 'host' | 'sandbox'): ClaudeAgentGrants => {
    const compiled = compileClaudeAgent({
      config: { extraArgs: [] },
      harnessName: 'Claude',
      agent: {
        tools,
        mcpServers: [],
        skills: [],
        environment: { name: 'sandboxed', isolation, network: ['registry.npmjs.org'], env: [] },
      },
      checkout: 'run-owned',
      servers: [],
      accountFile: '/h/.claude.json',
      host: { platform: 'darwin', denyRead: DENY, cliVersion: '2.1.330', settingsFiles: [] },
      checkoutPath: CHECKOUT,
    });
    if (!compiled.ok) throw new Error(compiled.problem);
    return compiled.grants;
  };
  /** From `--settings` to `--restricted`, less the report and the cap. */
  const policyPart = (argv: string[]): string[] => {
    const kept = argv.slice(argv.indexOf('--settings'), argv.indexOf('--restricted') + 1);
    for (const dropped of [
      ['--output-format', 'stream-json', '--verbose'],
      ['--max-turns', '40'],
    ]) {
      const from = kept.indexOf(dropped[0]);
      expect(kept.slice(from, from + dropped.length)).toEqual(dropped);
      kept.splice(from, dropped.length);
    }
    return kept;
  };
  const withoutConsolaTools = (flags: string[]) =>
    flags.filter((flag) => !flag.startsWith('mcp__consola__'));

  it.each([
    ['write', 'sandbox'],
    ['edit', 'sandbox'],
    ['write', 'host'],
  ] as const)('compiles a %s agent on %s as the canary launches one', async (tools, isolation) => {
    const { writeAgentFlags } = await load();
    const grants = grantsFor(tools, isolation);
    const launched = new ClaudeDriver().buildSessionArgs(
      { extraArgs: [] },
      {
        sessionId: 's1',
        resume: false,
        toolPolicy: tools,
        unattended: true,
        reportTurn: true,
        initialPrompt: 'p',
        maxTurns: 40,
        attentionUrl: 'http://127.0.0.1:9/h',
        grants,
      },
    );
    if (!Array.isArray(launched)) throw new Error('expected a plain array');
    const hooks = JSON.parse(launched[launched.indexOf('--settings') + 1]).hooks;
    expect(withoutConsolaTools(policyPart(launched))).toEqual(
      withoutConsolaTools(
        writeAgentFlags({
          tools,
          settings: isolation === 'sandbox' ? { sandbox: grants.sandbox?.settings } : { hooks },
          deny: [
            ...fileToolDenyRules(DENY, CHECKOUT),
            ...(tools === 'write' && isolation === 'host'
              ? ['Bash(git push:*)', 'Bash(gh:*)']
              : []),
          ],
        }),
      ),
    );
  });

  it("the deny list equals the canary's on one input", async () => {
    const { denyReadListFor } = await load();
    const input = {
      home: '/h',
      userData: '/h/Library/Application Support/Consola',
      factoryRoot: '/h/.consola/workspaces',
      profiles: ['/h/.claude-work'],
    };
    expect(denyReadList(input)).toEqual(denyReadListFor(input));
  });
});
