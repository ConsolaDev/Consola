import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ASSIGNED_REVIEWS_NAME, assignedReviewsEntry } from '../factoryTemplates';
import { FactoryFile } from './factoryFile';

describe('FactoryFile.appendAutomation', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-factory-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (text: string) => {
    const filePath = path.join(dir, 'factory.yml');
    fs.writeFileSync(filePath, text);
    return new FactoryFile(filePath);
  };

  it('appendAutomation keeps comments and existing entries, and the entry loads', async () => {
    const file = write(`# Mine, by hand.
version: 1
automations:
  # Every morning.
  - name: morning # the first one
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
    mode: confirm
  # - name: someday
  #   on: { cron: "0 10 * * *" }
`);
    await file.appendAutomation(assignedReviewsEntry());
    const text = fs.readFileSync(file.filePath, 'utf8');
    for (const kept of [
      '# Mine, by hand.',
      '# Every morning.',
      '# the first one',
      '# - name: someday',
    ])
      expect(text).toContain(kept);
    const loaded = await file.load();
    expect(loaded.spec.issues).toEqual([]);
    expect(loaded.spec.automations.map((automation) => automation.name)).toEqual([
      'morning',
      ASSIGNED_REVIEWS_NAME,
    ]);
  });

  it('appendAutomation fills an empty automations list', async () => {
    for (const empty of [
      'version: 1\nautomations:\n  # - name: someday\n  #   on: { cron: "0 10 * * *" }\n',
      'version: 1\nautomations: []\n',
    ]) {
      const file = write(empty);
      await file.appendAutomation(assignedReviewsEntry());
      const text = fs.readFileSync(file.filePath, 'utf8');
      if (empty.includes('someday')) expect(text).toContain('# - name: someday');
      const loaded = await file.load();
      expect(loaded.spec.issues).toEqual([]);
      expect(loaded.spec.automations.map((automation) => automation.name)).toEqual([
        ASSIGNED_REVIEWS_NAME,
      ]);
    }
  });

  it('appendAutomation leaves every other byte as it was', async () => {
    const original = `version: 1
automations:
    # Four spaces, a long flow map, and a quoted prompt that runs past eighty columns.
    -   name: sweep
        on: { cron: "0 9 * * *" }
        run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed], keep_branches: true } }
        mode: confirm
    -   name: summary
        on: { cron: "0 9 * * 1-5" }
        run: { prompt: "Use Consola's list_inbox tool to list my open pull requests and say which are blocked." }
        scope: api
    # - name: someday
`;
    const file = write(original);
    await file.appendAutomation(assignedReviewsEntry());
    const text = fs.readFileSync(file.filePath, 'utf8');
    const inserted = `${assignedReviewsEntry()
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}\n`;
    // Spliced in at the end of the list, at the list's own column; nothing else moved.
    expect(text.replace(inserted, '')).toBe(original);
    expect(text.indexOf(inserted)).toBeLessThan(text.indexOf('# - name: someday'));
    const loaded = await file.load();
    expect(loaded.spec.issues).toEqual([]);
    expect(loaded.spec.automations.map((automation) => automation.name)).toEqual([
      'sweep',
      'summary',
      ASSIGNED_REVIEWS_NAME,
    ]);
  });

  it('appendAutomation writes through a symlinked file, keeping the link', async () => {
    const target = path.join(dir, 'dotfiles-factory.yml');
    fs.writeFileSync(target, 'version: 1\nautomations: []\n');
    const link = path.join(dir, 'factory.yml');
    fs.symlinkSync(target, link);
    await new FactoryFile(link).appendAutomation(assignedReviewsEntry());
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain(`name: ${ASSIGNED_REVIEWS_NAME}`);
  });

  it('refuses a file that does not parse, leaving it as it was', async () => {
    const broken = 'version: 1\nautomations: [\n';
    const file = write(broken);
    await expect(file.appendAutomation(assignedReviewsEntry())).rejects.toThrow(/does not parse/);
    expect(fs.readFileSync(file.filePath, 'utf8')).toBe(broken);
  });
});

describe('FactoryFile.replaceAutomation', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-factory-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ORIGINAL = `# Kept with my dotfiles.
version: 1
automations:
  # Every weekday.
  - name: tidy
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
  # - name: someday
`;

  it('replaceAutomation keeps a symlinked file a link', async () => {
    const target = path.join(dir, 'dotfiles-factory.yml');
    fs.writeFileSync(target, ORIGINAL);
    const link = path.join(dir, 'factory.yml');
    fs.symlinkSync(target, link);
    const file = new FactoryFile(link);
    expect(await file.readText()).toBe(ORIGINAL);

    await file.replaceAutomation(
      'tidy',
      '- name: tidy\n  on: { cron: "0 7 * * 1-5" }\n  run: { tool: consola#cleanup_stale_sessions }\n  mode: confirm',
    );
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Every byte outside the entry as it was: the comments around it too.
    expect(fs.readFileSync(target, 'utf8')).toBe(
      ORIGINAL.replace(
        '    on: { cron: "0 9 * * *" }\n    run: { tool: consola#cleanup_stale_sessions }\n',
        '    on: { cron: "0 7 * * 1-5" }\n    run: { tool: consola#cleanup_stale_sessions }\n    mode: confirm\n',
      ),
    );
    expect(fs.readdirSync(dir).sort()).toEqual(['dotfiles-factory.yml', 'factory.yml']);
  });

  it('refuses a name that is not in the file, leaving it as it was', async () => {
    const filePath = path.join(dir, 'factory.yml');
    fs.writeFileSync(filePath, ORIGINAL);
    await expect(
      new FactoryFile(filePath).replaceAutomation(
        'gone',
        '- name: gone\n  on: { cron: "0 9 * * *" }\n  run: { tool: consola#x }',
      ),
    ).rejects.toThrow(/no automation named "gone"/);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(ORIGINAL);
  });

  it('readText is null when there is no file yet', async () => {
    expect(await new FactoryFile(path.join(dir, 'factory.yml')).readText()).toBeNull();
  });
});
