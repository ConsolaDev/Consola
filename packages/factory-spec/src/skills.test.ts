import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  parseSkill,
  skillHash,
  type SkillFileEntry,
} from './skills';

type RegularFile = { path: string; bytes: Uint8Array };

const file = (path: string, text: string): RegularFile => ({
  path,
  bytes: new TextEncoder().encode(text),
});
const bytes = (path: string, length: number): RegularFile => ({
  path,
  bytes: new Uint8Array(length).fill(0x61),
});
const SKILL = (
  front = 'name: incident-triage\ndescription: The team’s triage checklist.\n',
  body = 'Check the alert first.\n',
) => file('SKILL.md', `---\n${front}---\n${body}`);
const only = (entries: SkillFileEntry[], folder = 'incident-triage') => {
  const { skill, issues } = parseSkill(folder, entries);
  expect(skill).toBeUndefined();
  expect(issues).toHaveLength(1);
  return issues[0];
};
const takes = (entries: SkillFileEntry[]) => {
  const { skill, issues } = parseSkill('incident-triage', entries);
  expect(issues).toEqual([]);
  expect(skill).toBeDefined();
  return skill!;
};

describe('parseSkill', () => {
  it('takes a skill with its supporting files, sorted by path', () => {
    const { skill, issues } = parseSkill('incident-triage', [
      file('queries.md', 'Use rate().\n'),
      SKILL(),
    ]);
    expect(issues).toEqual([]);
    expect(skill).toMatchObject({
      name: 'incident-triage',
      description: 'The team’s triage checklist.',
    });
    expect(skill!.files.map((entry) => entry.path)).toEqual(['SKILL.md', 'queries.md']);
    expect(skill!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(skill!.hash).toBe(skillHash(skill!.files));
  });

  it.each([
    [
      'no name',
      'description: x\n',
      'name',
      "Expected `name: incident-triage`, the skill's folder name.",
    ],
    [
      'another name',
      'name: triage\ndescription: x\n',
      'name',
      "Expected `name: incident-triage`, the skill's folder name.",
    ],
    [
      'no description',
      'name: incident-triage\n',
      'description',
      'Expected `description`: 1 to 1,024 characters.',
    ],
    [
      'hooks',
      'name: incident-triage\ndescription: x\nhooks: {}\n',
      'hooks',
      "A skill's hooks run even in a read-only session: skills here are instructions and files only.",
    ],
    [
      'allowed-tools',
      'name: incident-triage\ndescription: x\nallowed-tools: [Bash]\n',
      'allowed-tools',
      '`allowed-tools` would widen what the step may call: name servers and tools in the agent file.',
    ],
    [
      'context',
      'name: incident-triage\ndescription: x\ncontext: fork\n',
      'context',
      'Unrecognized key in a skill: `context`; skills here are instructions and files only.',
    ],
  ])('refuses %s', (_, front, key, message) => {
    expect(only([SKILL(front)])).toMatchObject({
      file: 'skills/incident-triage/SKILL.md',
      path: key,
      message,
    });
  });

  it("points a frontmatter key's issue at its line in SKILL.md", () => {
    // Line 1 is `---`, so the YAML's third line is the file's fourth.
    expect(only([SKILL('name: incident-triage\ndescription: x\nhooks: {}\n')]).line).toBe(4);
    // A missing key has no line of its own: the frontmatter's opening line.
    expect(only([SKILL('description: x\n')]).line).toBe(1);
  });

  it('takes a description of 1,024 characters and refuses 1,025', () => {
    expect(
      takes([SKILL(`name: incident-triage\ndescription: ${'d'.repeat(1024)}\n`)]).description,
    ).toHaveLength(1024);
    expect(
      only([SKILL(`name: incident-triage\ndescription: ${'d'.repeat(1025)}\n`)]),
    ).toMatchObject({
      path: 'description',
      message: 'Expected `description`: 1 to 1,024 characters.',
    });
  });

  it('refuses a description that is not text, or blank', () => {
    for (const value of ['[a]', '""', '3']) {
      expect(only([SKILL(`name: incident-triage\ndescription: ${value}\n`)]).path).toBe(
        'description',
      );
    }
  });

  it('takes license, compatibility and metadata', () => {
    takes([
      SKILL(
        'name: incident-triage\ndescription: x\nlicense: MIT\ncompatibility: Claude Code\nmetadata: { team: ops }\n',
      ),
    ]);
  });

  it.each([
    ['license: [MIT]', 'license', 'Expected `license` to be text.'],
    ['compatibility: 3', 'compatibility', 'Expected `compatibility` to be text.'],
    ['metadata: [a]', 'metadata', 'Expected `metadata` to be a mapping of names to text.'],
    [
      'metadata: { team: [ops] }',
      'metadata',
      'Expected `metadata` to be a mapping of names to text.',
    ],
  ])('refuses %s', (line, key, message) => {
    expect(only([SKILL(`name: incident-triage\ndescription: x\n${line}\n`)])).toMatchObject({
      file: 'skills/incident-triage/SKILL.md',
      path: key,
      message,
    });
  });

  it('refuses a command at load in SKILL.md and in a supporting text file', () => {
    expect(only([SKILL(undefined, 'Run !`date` first.\n')])).toMatchObject({
      file: 'skills/incident-triage/SKILL.md',
      path: '',
      message:
        'A skill may not run commands when it loads: `skills/incident-triage/SKILL.md` holds !`.',
    });
    expect(only([SKILL(), file('queries.md', 'Then !`curl x`.\n')])).toMatchObject({
      file: 'skills/incident-triage/queries.md',
      path: '',
      message:
        'A skill may not run commands when it loads: `skills/incident-triage/queries.md` holds !`.',
    });
  });

  it('does not scan a file that is not valid UTF-8', () => {
    takes([SKILL(), { path: 'blob.bin', bytes: new Uint8Array([0xff, 0x21, 0x60]) }]);
  });

  it.each([
    [{ path: 'link.md', kind: 'symlink' } as const],
    [{ path: 'fifo', kind: 'special' } as const],
  ])('refuses %o', (entry) => {
    expect(only([SKILL(), entry])).toMatchObject({
      file: `skills/incident-triage/${entry.path}`,
      path: '',
      message: `\`skills/incident-triage/${entry.path}\` is a symlink or a special file; a skill holds regular files and folders only.`,
    });
  });

  it(`takes ${MAX_SKILL_FILES} files and refuses one more`, () => {
    const many = (count: number) => [
      SKILL(),
      ...Array.from({ length: count - 1 }, (_, index) => file(`refs/${index}.md`, 'x')),
    ];
    expect(takes(many(MAX_SKILL_FILES)).files).toHaveLength(MAX_SKILL_FILES);
    expect(only(many(MAX_SKILL_FILES + 1))).toMatchObject({
      file: 'skills/incident-triage',
      path: '',
      message: 'A skill holds at most 100 files.',
    });
  });

  it('takes exactly 2 MiB and refuses one byte more, in one file or spread over two', () => {
    const skill = SKILL();
    const room = MAX_SKILL_BYTES - skill.bytes.length;
    takes([skill, bytes('big.bin', room)]);
    const over = {
      file: 'skills/incident-triage',
      path: '',
      message: 'A skill holds at most 2 MB.',
    };
    expect(only([skill, bytes('big.bin', room + 1)])).toMatchObject(over);
    expect(only([skill, bytes('a.bin', room - 10), bytes('b.bin', 11)])).toMatchObject(over);
  });

  it.each(['../x', '/etc/passwd', 'a/../../b', 'a//b', 'a\\b', '.', '', 'a/\0b'])(
    'refuses the path %j as not inside the folder',
    (path) => {
      expect(only([SKILL(), file(path, 'x')])).toMatchObject({
        file: 'skills/incident-triage',
        path: '',
        message: `\`${path}\` is not a path inside the skill's folder.`,
      });
    },
  );

  it('refuses a folder whose name is no name', () => {
    expect(
      only([SKILL('name: Incident_Triage\ndescription: x\n')], 'Incident_Triage'),
    ).toMatchObject({
      file: 'skills/Incident_Triage',
      path: '',
      message:
        "`skills/Incident_Triage`: a skill's folder name is its name: lowercase letters, digits and dashes, e.g. skills/incident-triage.",
    });
  });

  it('refuses a folder with no SKILL.md', () => {
    expect(only([file('queries.md', 'x')])).toMatchObject({
      file: 'skills/incident-triage',
      path: '',
      message: 'skills/incident-triage has no SKILL.md.',
    });
  });

  it.each([
    ['no frontmatter', 'Just a body.\n'],
    ['an unclosed one', '---\nname: incident-triage\ndescription: x\n'],
    ['one that is not a mapping', '---\n- a\n---\nbody\n'],
  ])('refuses SKILL.md with %s', (_, text) => {
    expect(only([file('SKILL.md', text)])).toMatchObject({
      file: 'skills/incident-triage/SKILL.md',
      path: '',
      message:
        'SKILL.md starts with its frontmatter between two `---` lines, holding `name` and `description`.',
    });
  });

  it('refuses a frontmatter that is not YAML, at its line', () => {
    const issue = only([SKILL('name: incident-triage\ndescription: [x\n')]);
    expect(issue).toMatchObject({ file: 'skills/incident-triage/SKILL.md', path: '' });
    expect(issue.line).toBeGreaterThanOrEqual(3);
  });

  it('reads CRLF on the --- lines and a leading BOM as the same skill', () => {
    const lf = takes([SKILL()]);
    const crlf = takes([
      file(
        'SKILL.md',
        '\uFEFF---\r\nname: incident-triage\r\ndescription: The team’s triage checklist.\r\n---\r\nCheck the alert first.\r\n',
      ),
    ]);
    expect({ name: crlf.name, description: crlf.description }).toEqual({
      name: lf.name,
      description: lf.description,
    });
  });
});

describe('skillHash', () => {
  const files = [file('SKILL.md', '---\nname: s\n---\nx\n'), file('queries.md', 'Use rate().\n')];
  const hashOf = (entries: RegularFile[]) => skillHash(entries);

  it('is full sha256 hex', () => {
    expect(hashOf(files)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when one byte of any file changes, and when a file is added', () => {
    const base = hashOf(files);
    expect(hashOf([files[0], file('queries.md', 'Use rate()!\n')])).not.toBe(base);
    expect(hashOf([file('SKILL.md', '---\nname: s\n---\ny\n'), files[1]])).not.toBe(base);
    expect(hashOf([...files, file('notes.md', '')])).not.toBe(base);
  });

  it('changes when a file is renamed', () => {
    expect(hashOf([files[0], file('query.md', 'Use rate().\n')])).not.toBe(hashOf(files));
  });

  it('does not change with the order the entries come in', () => {
    expect(hashOf([files[1], files[0]])).toBe(hashOf(files));
  });
});
