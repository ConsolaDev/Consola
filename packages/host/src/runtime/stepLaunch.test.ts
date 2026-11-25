import { ClaudeSettings, ProviderInstanceId, ServerSettings } from '@t3tools/contracts';
import { parseCliArgs } from '@t3tools/shared/cliArgs';
import * as Schema from 'effect/Schema';
import { makeClaudeQueryOptions } from 't3/orchestration-v2/Adapters/ClaudeAdapterV2.ts';
import { claudeLaunchArgParseOptions } from 't3/provider/Drivers/ClaudeSkills.ts';
import { describe, expect, it } from 'vite-plus/test';
import {
  LOOSENING_LAUNCH_FLAGS,
  STEP_LAUNCH_ARGS,
  STEP_MCP_CONFIG_FILE,
  stepMcpConfig,
  stepT3Settings,
} from '../core/steps/stepSandbox.ts';
import { STEP_TOOL_CLI_NAMES } from '../core/steps/stepTools.ts';

/**
 * What an agent step's CLI is launched with, read the way t3 reads it: t3's settings in the step's
 * state folder, its Claude instance's `launchArgs` parsed by t3's own parser, and the Agent SDK
 * options t3's Claude adapter builds from them. That the CLI then keeps the checkout out is the
 * real CLI's to show (`scripts/step-sandbox-canary.mjs`; the desktop's canary row 3).
 */
describe("an agent step's launch", () => {
  it('ends in --restricted, loads the step tools alone, and widens nothing', () => {
    const tokens = STEP_LAUNCH_ARGS.split(' ');
    expect(tokens.at(-1)).toBe('--restricted');
    expect(tokens).toContain('--strict-mcp-config');
    for (const flag of LOOSENING_LAUNCH_FLAGS) expect(tokens).not.toContain(flag);
    // `--allowedTools` allows Consola's four step tools and nothing else.
    expect(tokens[tokens.indexOf('--allowedTools') + 1]?.split(',')).toEqual([
      ...STEP_TOOL_CLI_NAMES,
    ]);
  });

  it("is the Claude instance's launch arguments in t3's settings, as t3 decodes them", () => {
    const settings = Schema.decodeSync(ServerSettings)(stepT3Settings());
    expect(settings.enableProviderUpdateChecks).toBe(false);
    const instance = settings.providerInstances[ProviderInstanceId.make('claudeAgent')];
    expect(instance?.driver).toBe('claudeAgent');
    const claude = Schema.decodeUnknownSync(ClaudeSettings)(instance?.config);
    expect(claude.launchArgs).toBe(STEP_LAUNCH_ARGS);
  });

  it("reaches the Agent SDK as extra flags, leaving the thread's permission mode as it is", () => {
    expect(parseCliArgs(STEP_LAUNCH_ARGS, claudeLaunchArgParseOptions)).toEqual({
      flags: {
        'strict-mcp-config': null,
        'mcp-config': STEP_MCP_CONFIG_FILE,
        allowedTools: STEP_TOOL_CLI_NAMES.join(','),
        restricted: null,
      },
      positionals: [],
    });
    const settings = Schema.decodeSync(ClaudeSettings)({ launchArgs: STEP_LAUNCH_ARGS });
    const options = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-haiku-5-5',
      },
      nativeThreadId: '00000000-0000-4000-8000-000000000000',
      resume: false,
      cwd: '/workspace/repo',
      settings,
      permissionMode: 'default',
    });
    expect(options.permissionMode).toBe('default');
    expect(options.extraArgs).toMatchObject({
      'strict-mcp-config': null,
      'mcp-config': STEP_MCP_CONFIG_FILE,
      allowedTools: STEP_TOOL_CLI_NAMES.join(','),
      restricted: null,
    });
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
  });

  it('starts the step tools without the API key', () => {
    expect(stepMcpConfig('/workspace/.consola/step')).toEqual({
      mcpServers: {
        consola: {
          type: 'stdio',
          command: '/usr/bin/env',
          args: [
            '-u',
            'ANTHROPIC_API_KEY',
            '/usr/local/bin/node',
            '/opt/consola/consola-host.mjs',
            'step-tools',
            '--folder',
            '/workspace/.consola/step',
          ],
        },
      },
    });
  });
});
