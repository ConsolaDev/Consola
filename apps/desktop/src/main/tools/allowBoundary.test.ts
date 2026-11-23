import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Allow is the person's only (trust gate): no code an agent's call reaches may
 * reach `AutomationService.allow`. The control interface agents receive has no
 * `allow` (pinned by a type test in consolaTools.test.ts); this scans the
 * agent-facing source as well, so a tool that took the service some other way
 * is caught.
 */
const mainDir = join(__dirname, '..');
const agentFacing = [
  join(mainDir, 'tools'),
  join(mainDir, 'mcp'),
  join(mainDir, 'conductor'),
  join(mainDir, 'automations'),
  join(mainDir, '..', '..', '..', '..', 'packages', 'automation-engine', 'src', 'steps'),
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * `allow` reached as a member (`.allow`, `?.allow`, `['allow']`, `.allow.call(`)
 * or pulled out by destructuring (`const { allow } = …`, `{ a, allow: x }`).
 */
const ALLOW_ACCESS = /\??\.\s*allow\b|\[\s*['"`]allow['"`]\s*\]|\{[^{}]*\ballow\b[^{}]*\}\s*=[^=>]/;

describe('no agent-facing code reaches allow', () => {
  it('the matcher catches every way of reaching it', () => {
    for (const code of [
      'svc.allow(a, b, c)',
      'svc?.allow(a)',
      "svc['allow'](a)",
      'svc.allow.call(svc, a)',
      'const { allow } = svc;',
      'const { name, allow: let1 } = svc;',
    ]) {
      expect(code).toMatch(ALLOW_ACCESS);
    }
    expect('the allow-list, and { allowed } = x').not.toMatch(ALLOW_ACCESS);
  });

  it('finds the agent-facing directories', () => {
    for (const dir of agentFacing)
      expect(sources(dir).length, relative(mainDir, dir)).toBeGreaterThan(0);
  });

  it('touches allow in none of their source files', () => {
    for (const dir of agentFacing) {
      for (const file of sources(dir)) {
        expect(withoutComments(readFileSync(file, 'utf8')), file).not.toMatch(ALLOW_ACCESS);
      }
    }
  });
});

/**
 * A secret's binding is the person's too: where a value lives (a label is a
 * reference: `1Password (op://…)`, `the keychain (<service> · <account>)`)
 * and how to change it. No code an agent's call reaches may take the secrets
 * view, the Secrets channels, the bindings store or the desktop's port, or
 * import the modules that hold them. An agent is told names and flags only
 * (`capabilities().secrets`), which this does not match.
 */
const SECRET_ACCESS =
  /\b(?:secretsView|buildSecretsView|SECRETS_(?:LIST|BIND|UNBIND|CHANNELS)|secretsAPI|BindingsStore|desktopSecretsPort|bindSecret|registerSecretsIpc)\b|\bsecrets\/(?:BindingsStore|desktopSecrets|references|programs|secretsIpc)\b/;

describe('no agent-facing code reaches a secret’s binding', () => {
  it('the matcher catches every way of reaching one', () => {
    for (const code of [
      'automations.secretsView(workspaceId)',
      'buildSecretsView({ uses })',
      'IPC_CHANNELS.SECRETS_LIST',
      'IPC_CHANNELS.SECRETS_BIND',
      'IPC_CHANNELS.SECRETS_UNBIND',
      'window.secretsAPI.list(id)',
      'new BindingsStore(file, now)',
      'desktopSecretsPort(deps)',
      'await bindSecret(deps, id, name, input)',
      "import { x } from '../secrets/BindingsStore';",
      "import { x } from '../secrets/desktopSecrets';",
      "import { x } from '../secrets/references';",
      "import { x } from '../secrets/programs';",
      "import { x } from '../secrets/secretsIpc';",
      'registerSecretsIpc({ ipc, workspaces, bindings, automations, secretDeps })',
      'for (const channel of SECRETS_CHANNELS) ipc.handle(channel, x);',
    ]) {
      expect(code).toMatch(SECRET_ACCESS);
    }
    for (const code of [
      'command.secretNames',
      'secrets: [PAGER_TOKEN]',
      'step.secrets',
      'capabilities().secrets',
      "import { readSecrets } from '../secrets/readSecrets';",
    ]) {
      expect(code).not.toMatch(SECRET_ACCESS);
    }
  });

  it('touches a binding in none of their source files', () => {
    for (const dir of agentFacing) {
      for (const file of sources(dir)) {
        expect(withoutComments(readFileSync(file, 'utf8')), file).not.toMatch(SECRET_ACCESS);
      }
    }
  });
});

/**
 * Check server is the person's too (Call 12): it starts a factory server on
 * their Mac, once, on their press. No code an agent's call reaches may take
 * the service's `checkServer`, its channel, the desktop's MCP client or the
 * module that makes it, or end a server group itself. `endOrphan` is matched
 * as a call on something (`port.endOrphan(…)`): the engine's test seam in
 * `steps/steps.test-helpers.ts` defines a fake one, which reaches nothing.
 * `mcpWiring.ts` lives in `main/engineServers/`, outside every agent-facing
 * folder (review B2), which is why this scan passes with it in the tree.
 */
const CHECK_SERVER_ACCESS =
  /\b(?:checkServer|AUTOMATIONS_CHECK_SERVER|nodeMcpClient|automationMcpDeps)\b|automations:check-server|\.\s*endOrphan\b|\bengineServers\/mcpWiring\b/;

describe('no agent-facing code starts a server through Check server', () => {
  it('the matcher catches every way of reaching it', () => {
    for (const code of [
      'automations.checkServer(workspaceId, name, server, version)',
      'void automations.checkServer',
      'IPC_CHANNELS.AUTOMATIONS_CHECK_SERVER',
      "ipcRenderer.invoke('automations:check-server', a)",
      'nodeMcpClient({ baseEnv, workRoot })',
      'automationMcpDeps({ userDataDir, loginEnv })',
      'await mcp.endOrphan(group)',
      "import { automationMcpDeps } from '../engineServers/mcpWiring';",
    ]) {
      expect(code).toMatch(CHECK_SERVER_ACCESS);
    }
    for (const code of [
      'serverFactsOf(definition)',
      'const facts: ServerFacts = serverFacts',
      'mcpServers: { slack: { command: x } }',
      'servers: [slack]',
      'uses: slack#chat_post_message',
      'endOrphan: async (group) => world.ended.push(group)',
    ]) {
      expect(code).not.toMatch(CHECK_SERVER_ACCESS);
    }
  });

  it('reaches it from none of their source files', () => {
    for (const dir of agentFacing) {
      for (const file of sources(dir)) {
        expect(withoutComments(readFileSync(file, 'utf8')), file).not.toMatch(CHECK_SERVER_ACCESS);
      }
    }
  });
});
