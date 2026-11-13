import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFactorySpec } from '@consola/factory-spec';
import { ASSIGNED_REVIEWS_NAME, assignedReviewsEntry, FactoryFile, factoryTemplate } from './FactoryFile';

/**
 * What an editor's "toggle comment" does to a selection that is all comments:
 * removes one level from each line. Editors differ on the space after `#` —
 * VS Code takes it, Xcode leaves it — so both are exercised.
 */
function uncommentFrom(template: string, firstLine: string, marker: RegExp): string {
    const lines = template.split('\n');
    const start = lines.findIndex((line) => line.trim() === firstLine);
    expect(start).toBeGreaterThan(0);
    return lines.map((line, index) => (index >= start ? line.replace(marker, '$1') : line)).join('\n');
}

const TOGGLES = [
    ['removing "# " (VS Code)', /^(\s*)# ?/],
    ['removing only "#" (Xcode)', /^(\s*)#/],
] as const;

describe('factoryTemplate', () => {
    it('the template with a PR action loads review-assigned-prs live, in auto, on both events', () => {
        const result = parseFactorySpec(factoryTemplate('Review'));
        expect(result.issues).toEqual([]);
        expect(result.automations).toHaveLength(1);
        expect(result.automations[0]).toMatchObject({
            name: ASSIGNED_REVIEWS_NAME,
            mode: 'auto',
            trigger: { kind: 'event', connection: 'github', events: ['pull_request.review_requested', 'pull_request.assigned'] },
            run: { kind: 'action', ref: 'Review' },
            filter: { authors_not: ['dependabot[bot]'] },
        });
        // Says what it does before it does it.
        expect(factoryTemplate('Review')).toMatch(/asks for your review or is assigned to you/);
        expect(factoryTemplate('Review')).toMatch(/asks you once/);
    });

    it('the template without one loads no automations', () => {
        const text = factoryTemplate(null);
        expect(parseFactorySpec(text)).toEqual({ automations: [], issues: [] });
        expect(text).toContain('Add an action for pull requests in Settings › Actions, then uncomment this and name it under run.');
    });

    it.each(TOGGLES)('turns its examples on when they are all uncommented by %s', (_label, marker) => {
        const without = parseFactorySpec(uncommentFrom(factoryTemplate(null), '# - name: review-assigned-prs', marker));
        expect(without.issues).toEqual([]);
        expect(without.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME, 'clean-up-stale-sessions']);
    });

    it('turns the cleanup example on beside the live entry when "# " is removed', () => {
        // Removing only "#" leaves it one column right of the live entry, and
        // no layout lines up under both editors once an entry is live.
        const live = parseFactorySpec(uncommentFrom(factoryTemplate('Review'), '# - name: clean-up-stale-sessions', TOGGLES[0][1]));
        expect(live.issues).toEqual([]);
        expect(live.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME, 'clean-up-stale-sessions']);
    });

    it('an action name that needs quoting round-trips', () => {
        for (const action of ['Review: deep', 'Review #2', '"Quoted"', 'Re-view_2']) {
            const result = parseFactorySpec(factoryTemplate(action));
            expect(result.issues).toEqual([]);
            expect(result.automations[0].run).toMatchObject({ kind: 'action', ref: action });
        }
        // A plain name stays plain.
        expect(assignedReviewsEntry('Review code')).toContain('run: { action: Review code }');
    });
});

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
        await file.appendAutomation(assignedReviewsEntry('Review'));
        const text = fs.readFileSync(file.filePath, 'utf8');
        for (const kept of ['# Mine, by hand.', '# Every morning.', '# the first one', '# - name: someday']) expect(text).toContain(kept);
        const loaded = await file.load();
        expect(loaded.spec.issues).toEqual([]);
        expect(loaded.spec.automations.map((automation) => automation.name)).toEqual(['morning', ASSIGNED_REVIEWS_NAME]);
    });

    it('appendAutomation fills an empty automations list', async () => {
        for (const empty of ['version: 1\nautomations:\n  # - name: someday\n  #   on: { cron: "0 10 * * *" }\n', 'version: 1\nautomations: []\n']) {
            const file = write(empty);
            await file.appendAutomation(assignedReviewsEntry('Review'));
            const text = fs.readFileSync(file.filePath, 'utf8');
            if (empty.includes('someday')) expect(text).toContain('# - name: someday');
            const loaded = await file.load();
            expect(loaded.spec.issues).toEqual([]);
            expect(loaded.spec.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME]);
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
        await file.appendAutomation(assignedReviewsEntry('Review'));
        const text = fs.readFileSync(file.filePath, 'utf8');
        const inserted = `${assignedReviewsEntry('Review')
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n')}\n`;
        // Spliced in at the end of the list, at the list's own column; nothing else moved.
        expect(text.replace(inserted, '')).toBe(original);
        expect(text.indexOf(inserted)).toBeLessThan(text.indexOf('# - name: someday'));
        const loaded = await file.load();
        expect(loaded.spec.issues).toEqual([]);
        expect(loaded.spec.automations.map((automation) => automation.name)).toEqual(['sweep', 'summary', ASSIGNED_REVIEWS_NAME]);
    });

    it('appendAutomation writes through a symlinked file, keeping the link', async () => {
        const target = path.join(dir, 'dotfiles-factory.yml');
        fs.writeFileSync(target, 'version: 1\nautomations: []\n');
        const link = path.join(dir, 'factory.yml');
        fs.symlinkSync(target, link);
        await new FactoryFile(link).appendAutomation(assignedReviewsEntry('Review'));
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toContain(`name: ${ASSIGNED_REVIEWS_NAME}`);
    });

    it('refuses a file that does not parse, leaving it as it was', async () => {
        const broken = 'version: 1\nautomations: [\n';
        const file = write(broken);
        await expect(file.appendAutomation(assignedReviewsEntry('Review'))).rejects.toThrow(/does not parse/);
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
            '- name: tidy\n  on: { cron: "0 7 * * 1-5" }\n  run: { tool: consola#cleanup_stale_sessions }\n  mode: confirm'
        );
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        // Every byte outside the entry as it was: the comments around it too.
        expect(fs.readFileSync(target, 'utf8')).toBe(
            ORIGINAL.replace(
                '    on: { cron: "0 9 * * *" }\n    run: { tool: consola#cleanup_stale_sessions }\n',
                '    on: { cron: "0 7 * * 1-5" }\n    run: { tool: consola#cleanup_stale_sessions }\n    mode: confirm\n'
            )
        );
        expect(fs.readdirSync(dir).sort()).toEqual(['dotfiles-factory.yml', 'factory.yml']);
    });

    it('refuses a name that is not in the file, leaving it as it was', async () => {
        const filePath = path.join(dir, 'factory.yml');
        fs.writeFileSync(filePath, ORIGINAL);
        await expect(
            new FactoryFile(filePath).replaceAutomation('gone', '- name: gone\n  on: { cron: "0 9 * * *" }\n  run: { tool: consola#x }')
        ).rejects.toThrow(/no automation named "gone"/);
        expect(fs.readFileSync(filePath, 'utf8')).toBe(ORIGINAL);
    });

    it('readText is null when there is no file yet', async () => {
        expect(await new FactoryFile(path.join(dir, 'factory.yml')).readText()).toBeNull();
    });
});
