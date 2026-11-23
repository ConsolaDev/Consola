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
  /\b(?:secretsView|buildSecretsView|SECRETS_(?:LIST|BIND|UNBIND)|secretsAPI|BindingsStore|desktopSecretsPort|bindSecret)\b|\bsecrets\/(?:BindingsStore|desktopSecrets|references|programs)\b/;

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
