import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FactoryFileTree } from './FactoryFileTree';

/**
 * The file list's controls, as the definition page draws them: rendered to markup in Node, since
 * no test here touches a DOM. What they do is the domain's (`factoryNewFile.test.ts`,
 * `factoryDraft.test.ts`); this checks the page offers them, named, in the state it is given.
 */

const PATHS = ['factory.yml', 'agents/reviewer.md', 'automations/triage.yaml'];

const noop = () => {};

function render(props: { paths?: string[]; adding?: string | null; changed?: string[] } = {}) {
  return renderToStaticMarkup(
    <FactoryFileTree
      paths={props.paths ?? PATHS}
      active="agents/reviewer.md"
      changed={new Set(props.changed ?? [])}
      counts={new Map()}
      adding={props.adding ?? null}
      focusRow={null}
      onOpen={noop}
      onAddingChange={noop}
      onAdd={noop}
      onDelete={noop}
    />,
  );
}

describe('the file list', () => {
  it('offers New file beside the filter, closed until pressed', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*class="file-tree-new"[^>]*aria-label="New file"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('file-new-path');
  });

  it('offers a delete button on every file, named by its path', () => {
    const html = render();
    for (const path of PATHS) {
      expect(html).toContain(`aria-label="Delete ${path}"`);
    }
  });

  it('marks a file added and not saved yet as it marks any change', () => {
    const html = render({
      paths: [...PATHS, 'automations/review-pr.yaml'],
      changed: ['automations/review-pr.yaml'],
    });
    const row = (path: string) => html.split(`data-path="${path}"`)[1]?.split('</button>')[0];
    expect(row('automations/review-pr.yaml')).toContain('class="file-changed"');
    expect(row('automations/triage.yaml')).not.toContain('class="file-changed"');
  });

  it('says there are no files yet, and still offers New file', () => {
    const html = render({ paths: [] });
    expect(html).toContain('No files yet.');
    expect(html).toContain('aria-label="New file"');
  });
});

describe('the new file’s field', () => {
  it('asks for a path, offers an automation and an agent, and says how it is answered', () => {
    const html = render({ adding: '' });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="New file’s path"');
    expect(html).toContain('placeholder="e.g. agents/reviewer.md"');
    expect(html).toMatch(/class="file-new-start"[^>]*>.*Automation<\/button>/);
    expect(html).toMatch(/class="file-new-start"[^>]*>.*Agent<\/button>/);
    expect(html).toContain('Enter adds it. Esc cancels.');
  });

  it('says quietly why a path cannot be added, its path set as code', () => {
    const html = render({ adding: 'agents/reviewer.md' });
    expect(html).toContain('value="agents/reviewer.md"');
    expect(html).toContain(
      '<code>agents/reviewer.md</code><span> is already a file in this factory.</span>',
    );
    expect(html).not.toContain('data-tone="danger"');
    expect(html).not.toContain('aria-invalid');
  });

  it('says a refusal in the cell’s words', () => {
    const html = render({ adding: 'automations/review-pr.yml' });
    expect(html).toContain(
      '<code>automations/review-pr.yml</code><span> is not an automation: automation files are </span><code>automations/&lt;name&gt;.yaml</code>',
    );
  });

  it('says a folder whose files have no effect yet, and nothing for a path it takes', () => {
    expect(render({ adding: 'evals/smoke.yaml' })).toContain(
      '<span>Files in </span><code>evals/</code><span> are kept, but have no effect yet.</span>',
    );
    expect(render({ adding: 'automations/review-pr.yaml' })).toContain(
      'Enter adds it. Esc cancels.',
    );
  });
});
