import { parseFactory } from '@consola/factory-spec';
import type { Automation } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import type { FactoryFile } from './factory.js';
import { sourceOf } from './runSource.js';

const DEPLOY = `# Deploys the storefront.
on: manual
applies_to: [pr]
mode: confirm
steps:
  - id: build
    run: pnpm build
  - id: ship
    run: pnpm deploy
`;

const FACTORY_YML = `version: 1
automations:
  - name: nightly
    on: { cron: "0 3 * * *" }
    scope: storefront
    steps:
      - id: build
        run: pnpm build
  - name: reviews
    on: { github: { events: [pull_request.opened, pull_request.reopened] } }
    steps:
      - id: review
        prompt: Review it.
  - name: alerts
    on:
      poll: { every: 5m, run: "gh api /alerts", key: .id }
    scope: ops
    steps:
      - id: look
        prompt: Look at it.
`;

const FILES: FactoryFile[] = [
  { path: 'factory.yml', content: FACTORY_YML },
  { path: 'automations/deploy.yaml', content: DEPLOY },
];

function automation(name: string): Automation {
  const parsed = parseFactory({
    factoryYml: FACTORY_YML,
    automations: { deploy: DEPLOY },
    agents: {},
    skills: {},
    stray: [],
    laterFolders: [],
    unread: [],
    outside: [],
  });
  expect(parsed.issues).toEqual([]);
  const found = parsed.automations.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} did not parse`);
  return found;
}

describe('sourceOf', () => {
  it('gives an automation in a file of its own the whole file, and how it starts', () => {
    const read = sourceOf(automation('deploy'), FILES, 3, 5);
    expect(read?.source).toEqual({
      path: 'automations/deploy.yaml',
      version: 3,
      latestVersion: 5,
      text: DEPLOY,
      range: { start: 1, end: 9 },
      trigger: { kind: 'manual', detail: null },
      mode: 'confirm',
      appliesTo: ['pr'],
    });
    expect(Object.fromEntries(read?.stepLines ?? [])).toEqual({
      build: { start: 6, end: 7 },
      ship: { start: 8, end: 9 },
    });
  });

  it("gives an entry of factory.yml its own lines in the file, and its trigger's words", () => {
    const nightly = sourceOf(automation('nightly'), FILES, 1, 1)?.source;
    expect(nightly).toMatchObject({
      path: 'factory.yml',
      text: FACTORY_YML,
      range: { start: 3, end: 8 },
      trigger: { kind: 'cron', detail: '0 3 * * *' },
      // Written nowhere, a mode is `confirm`.
      mode: 'confirm',
      appliesTo: [],
    });
    expect(sourceOf(automation('reviews'), FILES, 1, 1)?.source.trigger).toEqual({
      kind: 'event',
      detail: 'pull_request.opened, pull_request.reopened',
    });
    expect(sourceOf(automation('alerts'), FILES, 1, 1)?.source.trigger).toEqual({
      kind: 'poll',
      detail: 'gh api /alerts',
    });
  });

  it('is null when the files hold none the automation names', () => {
    expect(sourceOf(automation('deploy'), [FILES[0]], 1, 1)).toBeNull();
  });
});
