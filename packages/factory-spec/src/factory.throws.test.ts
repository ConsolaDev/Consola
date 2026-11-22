import { describe, expect, it, vi } from 'vitest';
import { parseFactory, type FactoryFiles } from './factory';

/*
 * `parseFactory` never throws: a file whose own parser throws, for any
 * reason, is that file's issue (and unread, where the folder keeps that),
 * and every other file still parses. Each parser is made to throw here for
 * one name, `boom`.
 */

/** Throws for `boom`, else hands back what `parse` gives. */
const unlessBoom = <T>(name: string, parse: () => T): T => {
  if (name === 'boom') throw new Error('the parser fell over\nat line 7');
  return parse();
};

vi.mock('./agents', async (original) => {
  const actual = await original<typeof import('./agents')>();
  return {
    ...actual,
    parseAgentFile: (name: string, text: string) =>
      unlessBoom(name, () => actual.parseAgentFile(name, text)),
  };
});
vi.mock('./automationFile', async (original) => {
  const actual = await original<typeof import('./automationFile')>();
  return {
    ...actual,
    parseAutomationFile: (name: string, text: string) =>
      unlessBoom(name, () => actual.parseAutomationFile(name, text)),
  };
});
vi.mock('./skills', async (original) => {
  const actual = await original<typeof import('./skills')>();
  return {
    ...actual,
    parseSkill: (name: string, entries: Parameters<typeof actual.parseSkill>[1]) =>
      unlessBoom(name, () => actual.parseSkill(name, entries)),
  };
});
vi.mock('./parse', async (original) => {
  const actual = await original<typeof import('./parse')>();
  return {
    ...actual,
    parseFactoryYml: (text: string) =>
      unlessBoom(text.includes('boom') ? 'boom' : '', () => actual.parseFactoryYml(text)),
  };
});

const files = (over: Partial<FactoryFiles> = {}): FactoryFiles => ({
  factoryYml: null,
  automations: {},
  agents: {},
  skills: {},
  stray: [],
  laterFolders: [],
  unread: [],
  ...over,
});

const NIGHTLY = `on: { cron: "0 9 * * 1-5" }
scope: api
mode: auto
run: { prompt: Look at what changed in api overnight. }
`;
const REASON = 'Could not read `%s`: the parser fell over.';

describe('a file whose parser throws', () => {
  const cases: Array<[string, Partial<FactoryFiles>, string, boolean]> = [
    [
      'an agent file',
      { agents: { boom: '---\nmodel: opus\n---\nYou review.\n' } },
      'agents/boom.md',
      false,
    ],
    ['an automation file', { automations: { boom: NIGHTLY } }, 'automations/boom.yaml', true],
    [
      'a skill',
      { skills: { boom: [{ path: 'SKILL.md', bytes: new TextEncoder().encode('x') }] } },
      'skills/boom',
      false,
    ],
    ['factory.yml', { factoryYml: 'version: 1\nautomations: []\n# boom\n' }, 'factory.yml', true],
  ];
  it.each(cases)(
    'is %s’s issue, and the rest of the folder still parses',
    (_, over, file, unread) => {
      let result: ReturnType<typeof parseFactory> | undefined;
      expect(() => {
        result = parseFactory(
          files({
            ...over,
            automations: { nightly: NIGHTLY, ...over.automations },
          }),
        );
      }).not.toThrow();
      expect(result!.issues).toEqual([{ file, path: '', message: REASON.replace('%s', file) }]);
      expect(result!.unreadable).toEqual(unread ? [file] : []);
      expect(result!.automations.map((automation) => automation.name)).toEqual(['nightly']);
    },
  );
});
