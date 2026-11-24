import { describe, expect, it } from 'vitest';
import { parseAutomationEntry } from './entry';
import { parseFactory } from './factory';
import type { FactoryFiles } from './factory';

/*
 * YAML aliases (`*name`) can expand a short file into an enormous value, and
 * `yaml` throws past its limit rather than build it. A file that does that is
 * that file's issue, never an exception out of a parser: `parseFactory` never
 * throws, so one file can never stop a folder (or every workspace) loading.
 */

const TOO_MANY =
  'This file uses YAML aliases (`*name`) more than Consola reads: write the values out.';

/** 150 uses of one alias, as YAML mapping lines. */
const aliased = (): string => {
  const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
  for (let index = 0; index < 150; index++) lines.push(`b${index}: *a`);
  return `${lines.join('\n')}\n`;
};

const files = (over: Partial<FactoryFiles> = {}): FactoryFiles => ({
  factoryYml: null,
  automations: {},
  agents: {},
  skills: {},
  stray: [],
  laterFolders: [],
  unread: [],
  outside: [],
  ...over,
});

const NIGHTLY = `on: { cron: "0 9 * * 1-5" }
scope: api
mode: auto
run: { prompt: Look at what changed in api overnight. }
`;

describe('a file whose aliases expand past what Consola reads', () => {
  it('is an agent file’s issue, at its frontmatter, and its siblings still load', () => {
    const result = parseFactory(
      files({
        agents: { reviewer: `---\n${aliased()}---\nYou review.\n` },
        automations: { nightly: NIGHTLY },
      }),
    );
    expect(result.issues).toEqual([
      { file: 'agents/reviewer.md', path: '', line: 2, message: TOO_MANY },
    ]);
    expect(result.automations.map((automation) => automation.name)).toEqual(['nightly']);
  });

  it('is an automation file’s issue, and the file is unreadable', () => {
    const result = parseFactory(files({ automations: { nightly: NIGHTLY, x: aliased() } }));
    expect(result.issues).toEqual([
      { file: 'automations/x.yaml', automation: 'x', path: '', line: 1, message: TOO_MANY },
    ]);
    expect(result.unreadable).toEqual(['automations/x.yaml']);
    expect(result.automations.map((automation) => automation.name)).toEqual(['nightly']);
  });

  it('is factory.yml’s issue, and the file is unreadable', () => {
    const result = parseFactory(
      files({
        factoryYml: `version: 1\nautomations: []\n${aliased()}`,
        automations: { nightly: NIGHTLY },
      }),
    );
    expect(result.issues).toEqual([{ file: 'factory.yml', path: '', line: 1, message: TOO_MANY }]);
    expect(result.unreadable).toEqual(['factory.yml']);
    expect(result.automations.map((automation) => automation.name)).toEqual(['nightly']);
  });

  it('is a skill’s issue, in its SKILL.md', () => {
    const skill = `---\nname: triage\ndescription: Triage an alert.\n${aliased()}---\nTriage it.\n`;
    const result = parseFactory(
      files({ skills: { triage: [{ path: 'SKILL.md', bytes: new TextEncoder().encode(skill) }] } }),
    );
    expect(result.skills).toEqual({});
    expect(result.issues).toEqual([
      { file: 'skills/triage/SKILL.md', path: '', line: 2, message: TOO_MANY },
    ]);
  });

  it('is an entry handed in on its own: refused with the reason', () => {
    expect(
      parseAutomationEntry(`- name: x\n${aliased().replace(/^/gm, '  ').trimEnd()}\n`),
    ).toEqual({
      ok: false,
      issues: [{ path: '', line: 1, message: TOO_MANY }],
    });
  });

  it('still reads a file that uses an alias a few times', () => {
    const yml = `version: 1
automations:
  - name: nightly
    on: { cron: "0 9 * * 1-5" }
    scope: &scope api
    mode: auto
    run: { prompt: Look at what changed in api overnight. }
  - name: weekly
    on: { cron: "0 9 * * 1" }
    scope: *scope
    mode: auto
    run: { prompt: Look at what changed in api this week. }
`;
    const result = parseFactory(files({ factoryYml: yml }));
    expect(result.issues).toEqual([]);
    expect(result.automations.map((automation) => automation.scope)).toEqual(['api', 'api']);
  });
});
