import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  parseSkill,
  SKILL_TEXT_EXTENSIONS,
  skillHash,
} from './skills';
import type { SkillFileEntry } from './skills';

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

  it("refuses a command at load in SKILL.md's frontmatter too", () => {
    expect(only([SKILL('name: incident-triage\ndescription: Run !`date` first.\n')])).toMatchObject(
      {
        file: 'skills/incident-triage/SKILL.md',
        path: '',
        message:
          'A skill may not run commands when it loads: `skills/incident-triage/SKILL.md` holds !`.',
      },
    );
  });

  // The conductor's ruling on review S2: SKILL.md, a text file by its extension, and any valid
  // UTF-8 file are scanned, read leniently; only a binary (invalid UTF-8, no text extension) is not.
  const holds = (path: string) =>
    `A skill may not run commands when it loads: \`skills/incident-triage/${path}\` holds !\`.`;

  it('scans a text file by its extension even when it is not valid UTF-8, read leniently', () => {
    for (const path of ['notes.md', 'refs/run.sh', 'scripts/check.PY', 'data.json']) {
      expect(only([SKILL(), { path, bytes: new Uint8Array([0xff, 0x21, 0x60]) }])).toMatchObject({
        file: `skills/incident-triage/${path}`,
        message: holds(path),
      });
    }
    takes([SKILL(), { path: 'notes.md', bytes: new Uint8Array([0xff, 0x21, 0x20, 0x60]) }]);
  });

  it('scans SKILL.md whatever its bytes', () => {
    const skill = SKILL(undefined, 'Run !`date` first.\n');
    const bytes = new Uint8Array([...skill.bytes, 0xff]);
    expect(only([{ path: 'SKILL.md', bytes }])).toMatchObject({
      file: 'skills/incident-triage/SKILL.md',
      message: holds('SKILL.md'),
    });
  });

  it('scans a file with no text extension when it is valid UTF-8', () => {
    for (const path of ['Makefile', 'blob.bin', 'refs/table.dat']) {
      expect(only([SKILL(), file(path, 'Then !`curl x`.\n')])).toMatchObject({
        file: `skills/incident-triage/${path}`,
        message: holds(path),
      });
    }
  });

  it('takes a binary that holds the two bytes: invalid UTF-8 with no text extension', () => {
    // A PNG's signature, then `!` and a backtick in its data.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x21, 0x60, 0xff]);
    const skill = takes([SKILL(), { path: 'shots/alert.png', bytes: png }]);
    expect(skill.files.map((entry) => entry.path)).toEqual(['SKILL.md', 'shots/alert.png']);
    takes([SKILL(), { path: 'blob.bin', bytes: new Uint8Array([0xff, 0x21, 0x60]) }]);
    takes([
      SKILL(),
      { path: 'font.woff2', bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0xc0, 0x21, 0x60]) },
    ]);
  });

  it('names the text extensions in one list, compared without case', () => {
    expect(SKILL_TEXT_EXTENSIONS).toEqual(
      expect.arrayContaining(['md', 'txt', 'sh', 'py', 'js', 'ts', 'json', 'yaml', 'yml', 'toml']),
    );
    expect(SKILL_TEXT_EXTENSIONS.every((extension) => extension === extension.toLowerCase())).toBe(
      true,
    );
  });

  it.each([
    ['```!', '```!\ndate\n```\n'],
    ['~~~!', '~~~!\ndate\n~~~\n'],
    ['```` !, indented', 'Then:\n   ````  !\n   date\n   ````\n'],
    ['```! after CRLF', 'Then:\r\n```!\r\ndate\r\n```\r\n'],
  ])('refuses a fenced block that runs at load: %s', (_, body) => {
    const fenced = (path: string) =>
      `A skill may not run commands when it loads: \`skills/incident-triage/${path}\` has a fenced block that opens with !.`;
    expect(only([SKILL(undefined, body)])).toMatchObject({
      file: 'skills/incident-triage/SKILL.md',
      message: fenced('SKILL.md'),
    });
    expect(only([SKILL(), file('refs/run.md', body)])).toMatchObject({
      file: 'skills/incident-triage/refs/run.md',
      message: fenced('refs/run.md'),
    });
  });

  it('takes a ! that runs nothing: a plain fence, a backtick before it, a space between', () => {
    takes([
      SKILL(
        undefined,
        'Run:\n```bash\necho hi!\n```\nUse `!important` sparingly. Hello! `x`\n~~~\n!x\n~~~\n',
      ),
    ]);
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

  it.each(['../x', '/etc/passwd', 'a/../../b', 'a//b', String.raw`a\b`, '.', '', 'a/\0b'])(
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

  describe('paths that collide where case or accents are ignored', () => {
    const same = (a: string, b: string) =>
      `\`skills/incident-triage/${a}\` and \`skills/incident-triage/${b}\` name the same file where case or accents are ignored, as on macOS: rename one.`;

    it.each([
      [
        'SKILL.md and skill.md',
        [SKILL(), file('skill.md', 'Run anything.\n')],
        same('SKILL.md', 'skill.md'),
      ],
      [
        'skill.md and SKILL.md',
        [file('skill.md', 'Run anything.\n'), SKILL()],
        same('skill.md', 'SKILL.md'),
      ],
      [
        'two cases of a supporting file',
        [SKILL(), file('refs/Queries.md', 'a'), file('refs/queries.md', 'b')],
        same('refs/Queries.md', 'refs/queries.md'),
      ],
      [
        'a folder in two cases',
        [SKILL(), file('Refs/a.md', 'a'), file('refs/a.md', 'b')],
        same('Refs/a.md', 'refs/a.md'),
      ],
      [
        'NFC and NFD spellings',
        [SKILL(), file('café.md', 'a'), file('café.md', 'b')],
        same('café.md', 'café.md'),
      ],
      [
        'ß and ss',
        [SKILL(), file('straße.md', 'a'), file('STRASSE.md', 'b')],
        same('straße.md', 'STRASSE.md'),
      ],
      [
        'the same path twice',
        [SKILL(), file('a.md', 'a'), file('a.md', 'b')],
        same('a.md', 'a.md'),
      ],
    ])('refuses %s', (_, entries, message) => {
      expect(only(entries)).toMatchObject({ file: 'skills/incident-triage', path: '', message });
    });

    it('refuses a file where another entry puts a folder, in either order and either case', () => {
      const clash = (a: string, b: string) =>
        `\`skills/incident-triage/${a}\` is a file, and \`skills/incident-triage/${b}\` puts a folder in its place: rename one.`;
      expect(only([SKILL(), file('refs', 'a'), file('refs/q.md', 'b')]).message).toBe(
        clash('refs', 'refs/q.md'),
      );
      expect(only([SKILL(), file('refs/q.md', 'b'), file('refs', 'a')]).message).toBe(
        clash('refs', 'refs/q.md'),
      );
      expect(only([SKILL(), file('Refs', 'a'), file('refs/deep/q.md', 'b')]).message).toBe(
        clash('Refs', 'refs/deep/q.md'),
      );
      expect(only([file('SKILL.md/x', 'a'), SKILL()]).message).toBe(
        clash('SKILL.md', 'SKILL.md/x'),
      );
    });

    it('takes paths that only share a beginning', () => {
      takes([SKILL(), file('refs', 'a'), file('refs.md', 'b'), file('refs2/q.md', 'c')]);
    });

    it('refuses SKILL.md spelled another way, and checks nothing in it', () => {
      expect(only([file('Skill.md', '---\nhooks: {}\n---\nRun !`date`.\n')])).toMatchObject({
        file: 'skills/incident-triage',
        path: '',
        message:
          '`skills/incident-triage/Skill.md` is SKILL.md spelled another way: name it `SKILL.md`.',
      });
    });

    it('checks no frontmatter while two entries are SKILL.md', () => {
      // SKILL.md's own frontmatter would be refused, but which file a CLI loads is not known.
      expect(
        only([file('SKILL.md', '---\nhooks: {}\n---\nx\n'), file('skill.md', 'x')]).message,
      ).toBe(same('SKILL.md', 'skill.md'));
    });

    it('refuses a SKILL.md that is a symlink, once', () => {
      expect(only([{ path: 'SKILL.md', kind: 'symlink' }]).message).toBe(
        '`skills/incident-triage/SKILL.md` is a symlink or a special file; a skill holds regular files and folders only.',
      );
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
