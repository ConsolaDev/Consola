import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, seedRefusal } from './config.js';

const valid = {
  DATABASE_URL: 'pglite:memory',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'http://localhost:5175',
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 's',
};

function failureOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('loads a full environment', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: 'pglite:memory',
      authSecret: 'x'.repeat(32),
      publicUrl: 'http://localhost:5175',
      port: 3100,
      region: 'eu',
      google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 's' },
      github: null,
      githubWebhookSecret: null,
      runner: null,
      connectionSecretsKey: null,
      slackPublicUrl: 'http://localhost:5175',
    });
  });

  describe('the region', () => {
    it('is eu when unset or empty', () => {
      expect(loadConfig(valid).region).toBe('eu');
      expect(loadConfig({ ...valid, REGION: '' }).region).toBe('eu');
    });

    it('reads REGION', () => {
      expect(loadConfig({ ...valid, REGION: 'us' }).region).toBe('us');
    });

    it('refuses a region that is not listed', () => {
      for (const region of ['EU', 'ap', 'eu-west']) {
        const failure = failureOf({ ...valid, REGION: region });
        expect(failure.problems).toEqual([expect.stringMatching(/^REGION: must be one of eu, us/)]);
      }
    });
  });

  it('ignores the settings the two apps it replaced read', () => {
    const old = {
      CELL_TOKEN_PRIVATE_KEY: 'not-a-key',
      CELL_URL_EU: 'acme-cell',
      CELL_PUBLIC_KEY_EU: 'nope',
      CLOUD_GLOBAL_URL: 'ftp://global.sprocket.test',
    };
    expect(loadConfig({ ...valid, ...old })).toEqual(loadConfig(valid));
  });

  describe("the GitHub App's webhook secret", () => {
    const secret = 'sprocket-webhook-secret-0123456789abcdef';

    it('is read as it is, whatever else is set', () => {
      expect(loadConfig({ ...valid, GITHUB_WEBHOOK_SECRET: secret }).githubWebhookSecret).toBe(
        secret,
      );
    });

    it('is optional, and an empty one counts as unset', () => {
      expect(loadConfig({ ...valid, GITHUB_WEBHOOK_SECRET: '' }).githubWebhookSecret).toBeNull();
    });

    it('is refused when shorter than 32 characters, without being quoted', () => {
      const failure = failureOf({ ...valid, GITHUB_WEBHOOK_SECRET: 'sprocket-short' });
      expect(failure.problems).toEqual([
        expect.stringMatching(/^GITHUB_WEBHOOK_SECRET: must be at least 32 characters/),
      ]);
      expect(failure.message).not.toContain('sprocket-short');
    });
  });

  describe("the GitHub App's settings", () => {
    const app = {
      GITHUB_APP_CLIENT_ID: 'Iv23liSprocketTest',
      GITHUB_APP_CLIENT_SECRET: 'sprocket-client-secret',
      GITHUB_APP_SLUG: 'consola-dev',
      GITHUB_APP_PRIVATE_KEY_PATH: '/keys/github-app.pem',
    };

    it('reads all four', () => {
      expect(loadConfig({ ...valid, ...app }).github).toEqual({
        clientId: 'Iv23liSprocketTest',
        clientSecret: 'sprocket-client-secret',
        slug: 'consola-dev',
        privateKeyPath: '/keys/github-app.pem',
      });
    });

    it('are optional together, and an empty one counts as unset', () => {
      const empty = Object.fromEntries(Object.keys(app).map((name) => [name, '']));
      expect(loadConfig({ ...valid, ...empty, GITHUB_APP_ID: '' }).github).toBeNull();
    });

    it('do not need the app ID or the webhook secret', () => {
      expect(
        loadConfig({ ...valid, ...app, GITHUB_APP_ID: '', GITHUB_WEBHOOK_SECRET: '' }).github,
      ).not.toBeNull();
    });

    it('refuse a half-set app, naming each one missing', () => {
      const failure = failureOf({ ...valid, GITHUB_APP_SLUG: 'consola-dev' });
      expect(failure.problems).toEqual([
        expect.stringMatching(/^GITHUB_APP_CLIENT_ID: is required once any/),
        expect.stringMatching(/^GITHUB_APP_CLIENT_SECRET: is required once any/),
        expect.stringMatching(/^GITHUB_APP_PRIVATE_KEY_PATH: is required once any/),
      ]);
    });

    it('refuse a slug that is not one, alongside the other problems', () => {
      const failure = failureOf({
        ...valid,
        ...app,
        GITHUB_APP_SLUG: 'https://github.com/apps/consola-dev',
        BETTER_AUTH_SECRET: 'short',
      });
      expect(failure.problems).toEqual([
        expect.stringContaining('BETTER_AUTH_SECRET'),
        expect.stringMatching(/^GITHUB_APP_SLUG: must be the name in the app's address/),
      ]);
    });

    it('never quote the client secret', () => {
      const failure = failureOf({ ...valid, GITHUB_APP_CLIENT_SECRET: 'sprocket-secret-value' });
      expect(failure.message).not.toContain('sprocket-secret-value');
    });
  });

  describe('PORT', () => {
    it('reads PORT when set', () => {
      expect(loadConfig({ ...valid, PORT: '4000' }).port).toBe(4000);
    });

    it('takes an empty PORT as unset', () => {
      expect(loadConfig({ ...valid, PORT: '' }).port).toBe(3100);
    });

    it('refuses a port out of range, or no number', () => {
      for (const port of ['0', '65536', '31.5', 'abc']) {
        const failure = failureOf({ ...valid, PORT: port });
        expect(failure.problems).toEqual([expect.stringMatching(/^PORT: /)]);
      }
    });
  });

  it('drops a trailing slash from PUBLIC_URL', () => {
    expect(loadConfig({ ...valid, PUBLIC_URL: 'http://localhost:5175/' }).publicUrl).toBe(
      'http://localhost:5175',
    );
  });

  it('refuses PUBLIC_URL with a path', () => {
    const failure = failureOf({ ...valid, PUBLIC_URL: 'http://localhost:5175/app' });
    expect(failure.problems.join('\n')).toContain('PUBLIC_URL');
  });

  it('accepts postgres, postgresql and pglite database URLs', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/cloud',
      'postgresql://u:p@localhost:5432/cloud',
      'pglite:memory',
      'pglite:./.data/cloud-db',
    ]) {
      expect(loadConfig({ ...valid, DATABASE_URL: url }).databaseUrl).toBe(url);
    }
  });

  it('refuses an unknown database scheme', () => {
    const failure = failureOf({ ...valid, DATABASE_URL: 'mysql://x' });
    expect(failure.problems).toEqual([expect.stringMatching(/^DATABASE_URL: /)]);
  });

  it('refuses a short secret', () => {
    const failure = failureOf({ ...valid, BETTER_AUTH_SECRET: 'x'.repeat(31) });
    expect(failure.problems.join('\n')).toContain('BETTER_AUTH_SECRET');
  });

  it('ignores the organisation settings an older .env still has', () => {
    expect(loadConfig({ ...valid, ORG_NAME: 'Sprocket', ORG_SLUG: 'Sprocket Inc' })).toEqual(
      loadConfig(valid),
    );
  });

  it('names every problem at once', () => {
    const failure = failureOf({ REGION: 'ap' });
    for (const name of [
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
      'PUBLIC_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'REGION',
    ]) {
      expect(failure.problems.some((p) => p.startsWith(`${name}:`))).toBe(true);
      expect(failure.message).toContain(name);
    }
  });
});

// Stand-ins, never real credentials: a runner secret and a pass key's JWK on one line.
const SECRET = 'sprocket-runner-secret-0123456789abcdef';
const JWK = { kty: 'OKP', crv: 'Ed25519', x: 'x-of-the-key', d: 'd-of-the-key' };
const runner = {
  RUNNER_SECRET: SECRET,
  RUNNER_WORKSPACE_ID: 'acme',
  PASS_PRIVATE_KEY: JSON.stringify(JWK),
};

describe('loadConfig, the runner and its passes', () => {
  it('has no runner when none of its three settings is set, or each is empty', () => {
    expect(loadConfig(valid).runner).toBeNull();
    expect(
      loadConfig({ ...valid, RUNNER_SECRET: '', RUNNER_WORKSPACE_ID: '', PASS_PRIVATE_KEY: '' })
        .runner,
    ).toBeNull();
  });

  it('reads all three together, the key as the JSON object it holds', () => {
    expect(loadConfig({ ...valid, ...runner }).runner).toEqual({
      secret: SECRET,
      workspaceId: 'acme',
      passPrivateKey: JWK,
    });
  });

  it.each([['RUNNER_SECRET'], ['RUNNER_WORKSPACE_ID'], ['PASS_PRIVATE_KEY']] as const)(
    'refuses the other two without %s, so no session starts without a key',
    (left) => {
      for (const unset of [undefined, '']) {
        const failure = failureOf({ ...valid, ...runner, [left]: unset });
        expect(failure.problems).toEqual([expect.stringMatching(new RegExp(`^${left}: `))]);
        expect(failure.message).not.toContain(SECRET);
        expect(failure.message).not.toContain('d-of-the-key');
      }
    },
  );

  it('refuses one of the three alone, naming the two it needs', () => {
    const failure = failureOf({ ...valid, RUNNER_SECRET: SECRET });
    expect(failure.problems).toEqual([
      expect.stringMatching(/^RUNNER_WORKSPACE_ID: /),
      expect.stringMatching(/^PASS_PRIVATE_KEY: /),
    ]);
    expect(failure.message).not.toContain(SECRET);
  });

  it.each([
    ['shorter than 32 characters', 'short-secret'],
    ['with a space', 'sprocket runner secret 0123456789abcdef'],
    ['with a character no header carries', 'sprocket-runner-secret-0123456789abcdéf'],
  ])('refuses a RUNNER_SECRET %s, never quoting it', (_what, secret) => {
    const failure = failureOf({ ...valid, ...runner, RUNNER_SECRET: secret });
    expect(failure.problems).toEqual([expect.stringMatching(/^RUNNER_SECRET: /)]);
    expect(failure.message).not.toContain(secret);
  });

  it.each([
    ['not JSON', '{"kty":"OKP","d":"d-of-the-key"'],
    ['a JSON list', JSON.stringify([JWK])],
    ['a JSON string', JSON.stringify('d-of-the-key')],
    ['JSON null', 'null'],
  ])('refuses a PASS_PRIVATE_KEY that is %s, never quoting it', (_what, key) => {
    const failure = failureOf({ ...valid, ...runner, PASS_PRIVATE_KEY: key });
    expect(failure.problems).toEqual([expect.stringMatching(/^PASS_PRIVATE_KEY: /)]);
    expect(failure.message).not.toContain('d-of-the-key');
  });

  it("names the runner's problems beside every other", () => {
    const failure = failureOf({ ...valid, BETTER_AUTH_SECRET: 'short', RUNNER_SECRET: SECRET });
    expect(failure.problems).toEqual([
      expect.stringMatching(/^BETTER_AUTH_SECRET: /),
      expect.stringMatching(/^RUNNER_WORKSPACE_ID: /),
      expect.stringMatching(/^PASS_PRIVATE_KEY: /),
    ]);
  });
});

describe('the connection secrets key', () => {
  // 32 bytes in base64: a stand-in, never a real key.
  const KEY = 'c3Byb2NrZXQtY29ubmVjdGlvbi1zZWNyZXRzLWtleSE=';

  it('is null when unset or empty: then Slack is off', () => {
    expect(loadConfig(valid).connectionSecretsKey).toBeNull();
    expect(loadConfig({ ...valid, CONNECTION_SECRETS_KEY: '' }).connectionSecretsKey).toBeNull();
  });

  it('reads 32 bytes in base64', () => {
    expect(loadConfig({ ...valid, CONNECTION_SECRETS_KEY: KEY }).connectionSecretsKey).toBe(KEY);
  });

  it.each([
    ['too short', 'c3Byb2NrZXQ='],
    ['too long', `${KEY.slice(0, -1)}AAAA`],
    ['not base64', `${'!'.repeat(43)}=`],
  ])('refuses one that is %s, never quoting it', (_what, key) => {
    const failure = failureOf({ ...valid, CONNECTION_SECRETS_KEY: key });
    expect(failure.problems).toEqual([expect.stringMatching(/^CONNECTION_SECRETS_KEY: /)]);
    expect(failure.message).not.toContain(key);
  });
});

describe("Slack's public address", () => {
  it('is PUBLIC_URL when SLACK_PUBLIC_URL is unset or empty', () => {
    expect(loadConfig(valid).slackPublicUrl).toBe('http://localhost:5175');
    expect(loadConfig({ ...valid, SLACK_PUBLIC_URL: '' }).slackPublicUrl).toBe(
      'http://localhost:5175',
    );
  });

  it('reads SLACK_PUBLIC_URL, a tunnel’s address, without its slash', () => {
    expect(
      loadConfig({ ...valid, SLACK_PUBLIC_URL: 'https://sprocket-dev.trycloudflare.com/' })
        .slackPublicUrl,
    ).toBe('https://sprocket-dev.trycloudflare.com');
  });

  it('refuses one with a path', () => {
    const failure = failureOf({ ...valid, SLACK_PUBLIC_URL: 'https://sprocket.test/api' });
    expect(failure.problems).toEqual([expect.stringMatching(/^SLACK_PUBLIC_URL: /)]);
  });
});

describe('seedRefusal', () => {
  it('lets the demo seed write to a local PGlite folder only', () => {
    expect(seedRefusal('pglite:./.data/cloud-db')).toBeNull();
    for (const url of [
      'postgres://consola@localhost:5432/cloud',
      'postgresql://consola@db.example.com/cloud',
      'pglite:memory',
      'pglite:',
    ]) {
      expect([url, seedRefusal(url)]).toEqual([url, expect.any(String)]);
    }
  });
});
