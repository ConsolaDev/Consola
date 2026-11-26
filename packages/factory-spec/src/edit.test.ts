import { describe, expect, it } from 'vitest';
import { parseAutomationFile } from './automationFile';
import {
  appendAutomationEntry,
  automationEntryText,
  automationFileText,
  automationItemText,
  replaceAutomationEntry,
} from './edit';
import { parseAutomationEntry } from './entry';
import { parseFactorySpec } from './parse';

const FILE = `# factory.yml
version: 1
automations:
  - name: a
    on: { cron: "0 9 * * *" }
    run: { tool: consola#x }
  - name: b
    on: { cron: "0 10 * * *" }
    run: { tool: consola#y }
  # a note between entries
  - name: c
    on: { cron: "0 11 * * *" }
    run: { tool: consola#z }
  # - name: example
  #   on: { cron: "0 12 * * *" }
`;

const STEPS_ENTRY = [
  '- name: review-assigned-prs',
  '  on:',
  '    github:',
  '      events:',
  '        - pull_request.review_requested',
  '        - pull_request.assigned',
  '      filter:',
  '        authors_not:',
  '          - dependabot[bot]',
  '  mode: auto',
  '  steps:',
  '    - id: fresh',
  '      run: |',
  '        reviewed=$(gh api graphql -f url="$PR" -f query=\'',
  '          query($url: URI!) { resource(url: $url) { ... on PullRequest {',
  "            viewerLatestReview { commit { oid } } } } }' \\",
  '          --jq \'.data.resource.viewerLatestReview.commit.oid // ""\')',
  '        if [ "$reviewed" = "$CONSOLA_CHECKOUT_HEAD" ]; then needed=false; else needed=true; fi',
  '        echo "needed=$needed" >> "$CONSOLA_OUTPUT"',
  '      env: { PR: "{{item.url}}" }',
  '      outputs: { needed: { type: boolean } }',
  '      dry_run: run',
  '    - id: review',
  '      if: steps.fresh.needed',
  '      prompt: >-',
  "        Review this pull request. Read it with Consola's work_item_context tool, and read the changed files",
  '        in this folder where it helps. Then set verdict: approve if you would merge it as it is.',
  '      outputs:',
  '        verdict: { enum: [approve, comment, request-changes] }',
  '    - id: publish',
  '      if: steps.fresh.needed',
  '      run: |',
  '        event=COMMENT',
  '        if [ "$VERDICT" = "request-changes" ]; then event=REQUEST_CHANGES; fi',
  '        gh api "repos/$REPO/pulls/$NUMBER/reviews" \\',
  '          -f commit_id="$CONSOLA_CHECKOUT_HEAD" -f event="$event" -F body=@"$BODY_FILE"',
  '      env:',
  '        REPO: "{{item.repo}}"',
  '        NUMBER: "{{item.number}}"',
  '        VERDICT: "{{steps.review.verdict}}"',
  '        BODY_FILE: "{{steps.review.handover.file}}"',
].join('\n');

const NEW_B = '- name: b\n  on: { cron: "30 10 * * *" }\n  mode: auto\n  run: { tool: consola#y }';

describe('replaceAutomationEntry', () => {
  it('replaces an entry in place, keeping comments and neighbours byte for byte', () => {
    const expected = FILE.replace(
      '  - name: b\n    on: { cron: "0 10 * * *" }\n    run: { tool: consola#y }\n',
      '  - name: b\n    on: { cron: "30 10 * * *" }\n    mode: auto\n    run: { tool: consola#y }\n',
    );
    expect(replaceAutomationEntry(FILE, 'b', NEW_B)).toBe(expected);
  });

  it('replaces the last entry and a flow-style entry', () => {
    const last = replaceAutomationEntry(
      FILE,
      'c',
      '- name: c\n  on: { cron: "5 5 * * *" }\n  run: { tool: consola#z }\n',
    );
    expect(last).toBe(FILE.replace('"0 11 * * *"', '"5 5 * * *"'));

    const flow =
      'version: 1\nautomations:\n  - { name: c, on: { cron: "0 11 * * *" }, run: { tool: consola#z } }\n  # tail\n';
    const result = replaceAutomationEntry(
      flow,
      'c',
      '- name: c\n  on: { cron: "1 1 * * *" }\n  run: { tool: consola#z }',
    );
    expect(result).toBe(
      'version: 1\nautomations:\n  - name: c\n    on: { cron: "1 1 * * *" }\n    run: { tool: consola#z }\n  # tail\n',
    );
  });

  it('keeps the blank line after an entry that ends in a block scalar', () => {
    const file =
      'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    scope: s\n    run:\n      prompt: |\n        line one\n        line two\n\n  - name: b\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#y }\n';
    const entry = '- name: a\n  on: { cron: "0 9 * * *" }\n  run: { tool: consola#x }';
    expect(replaceAutomationEntry(file, 'a', entry)).toBe(
      'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n\n  - name: b\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#y }\n',
    );
  });

  it('throws when the name is missing, the file does not parse, or the new entry has a different name', () => {
    expect(() => replaceAutomationEntry(FILE, 'x', NEW_B)).toThrow(/no automation named "x"/);
    expect(() => replaceAutomationEntry('automations: [\n', 'b', NEW_B)).toThrow(/does not parse/);
    expect(() =>
      replaceAutomationEntry(FILE, 'b', NEW_B.replace('name: b', 'name: other')),
    ).toThrow(/name/);
  });
});

describe('appendAutomationEntry', () => {
  it('gives an empty or comments-only file the version line it needs, keeping what it holds', () => {
    const entry = '- name: a\n  on: { cron: "0 9 * * *" }\n  run: { tool: consola#x }';
    for (const empty of ['', '\n', '# Mine, for later.\n', '# No newline at the end']) {
      const result = appendAutomationEntry(empty, entry);
      expect(result.startsWith(empty)).toBe(true);
      expect(parseFactorySpec(result), JSON.stringify(empty)).toMatchObject({
        issues: [],
        automations: [{ name: 'a' }],
      });
    }
    // A file that already says its version gets only the list.
    expect(appendAutomationEntry('version: 1\n', entry)).toBe(
      `version: 1\nautomations:\n${entry.replace(/^/gm, '  ')}\n`,
    );
  });
});

describe('automationEntryText', () => {
  it('returns the entry dedented, or null', () => {
    expect(automationEntryText(FILE, 'b')).toBe(
      '- name: b\n  on: { cron: "0 10 * * *" }\n  run: { tool: consola#y }',
    );
    expect(automationEntryText(FILE, 'nope')).toBeNull();
  });
});

describe('an entry with nested steps and block scalars', () => {
  it('parses, appends and replaces an entry with nested steps and block scalars', () => {
    const parsed = parseAutomationEntry(STEPS_ENTRY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.automation.steps?.map((step) => step.id)).toEqual(['fresh', 'review', 'publish']);
    const fresh = parsed.automation.steps?.[0];
    expect(fresh?.kind === 'run' && fresh.run).toContain(
      'echo "needed=$needed" >> "$CONSOLA_OUTPUT"\n',
    );

    const indented = STEPS_ENTRY.split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    // It lands after the last entry and before the trailing comment, as any entry does.
    const tail = '  # - name: example\n  #   on: { cron: "0 12 * * *" }\n';
    expect(FILE.endsWith(tail)).toBe(true);
    const appended = appendAutomationEntry(FILE, STEPS_ENTRY);
    expect(appended).toBe(`${FILE.slice(0, -tail.length)}${indented}\n${tail}`);
    const reparsed = parseFactorySpec(appended);
    expect(reparsed.issues).toEqual([]);
    expect(reparsed.automations.map((a) => a.name)).toEqual(['a', 'b', 'c', 'review-assigned-prs']);

    const replaced = replaceAutomationEntry(
      appended,
      'b',
      STEPS_ENTRY.replace('review-assigned-prs', 'b'),
    );
    const oldB = '  - name: b\n    on: { cron: "0 10 * * *" }\n    run: { tool: consola#y }\n';
    expect(appended).toContain(oldB);
    expect(replaced).toBe(
      appended.replace(oldB, `${indented.replace('review-assigned-prs', 'b')}\n`),
    );
    // And back: replacing it with the original entry restores the file byte for byte.
    expect(
      replaceAutomationEntry(
        replaced,
        'b',
        '- name: b\n  on: { cron: "0 10 * * *" }\n  run: { tool: consola#y }',
      ),
    ).toBe(appended);
  });
});

const INVESTIGATE = [
  '- name: investigate-alerts',
  '  # Checks the alert channel every five minutes.',
  '  on:',
  '    poll:',
  '      every: 5m',
  '      run: |',
  '        gh api /alerts --jq "[.[] | { ts, title }]"',
  '      key: .ts',
  '  scope: ops-notes',
  '  mode: auto # runs unasked once allowed',
  '  steps:',
  '    - id: investigate',
  '      agent: investigator',
  '      outputs:',
  '        severity: { enum: [noise, low, high] }',
].join('\n');

const placeless = <T extends { file?: string; line?: number }>({
  file: _file,
  line: _line,
  ...rest
}: T) => rest;

describe('automationFileText and automationItemText', () => {
  const entry = parseAutomationEntry(INVESTIGATE);
  if (!entry.ok) throw new Error(JSON.stringify(entry.issues));

  it('writes an item as the text of its own file: no name:, comments kept, the same automation', () => {
    const text = automationFileText(entry.item);
    expect(text).not.toMatch(/^\s*-?\s*name:/m);
    expect(text).toContain('# Checks the alert channel every five minutes.');
    expect(text).toContain('# runs unasked once allowed');
    expect(text.startsWith('-')).toBe(false);
    const parsed = parseAutomationFile('investigate-alerts', text);
    expect(parsed.issues).toEqual([]);
    expect(placeless(parsed.automation!)).toEqual(placeless(entry.automation));
  });

  it.each([
    ['above the first key', '\n'],
    ['set apart by a blank line', '\n\n'],
  ])(
    'turns a file back into the item parseAutomationEntry takes, a header comment %s kept',
    (_, gap) => {
      const fileText = `# automations/investigate-alerts.yaml${gap}${automationFileText(entry.item)}`;
      const item = automationItemText('investigate-alerts', fileText);
      expect(item.startsWith('- name: investigate-alerts\n')).toBe(true);
      expect(item).toContain('# automations/investigate-alerts.yaml');
      expect(item).toContain('# Checks the alert channel every five minutes.');
      expect(item.endsWith('\n')).toBe(false);
      const back = parseAutomationEntry(item);
      expect(back.ok && back.automation).toEqual(entry.automation);
    },
  );

  it('keeps a header comment set apart from a first key that has none', () => {
    const fileText =
      '# automations/daily.yaml\n\non: { cron: "0 9 * * *" }\nscope: ops-notes\nsteps:\n  - prompt: Write the digest.\n';
    const item = automationItemText('daily', fileText);
    expect(item.startsWith('- name: daily\n')).toBe(true);
    expect(item).toContain('# automations/daily.yaml');
    const back = parseAutomationEntry(item);
    expect(back.ok && back.automation).toMatchObject({ name: 'daily', scope: 'ops-notes' });
  });

  it('refuses what is not one automation', () => {
    expect(() => automationFileText('- name: a\n- name: b')).toThrow();
    expect(() => automationFileText('nope: [')).toThrow();
    expect(() => automationItemText('a', '- on: x\n')).toThrow();
    expect(() => automationItemText('a', 'on: [\n')).toThrow();
  });
});
