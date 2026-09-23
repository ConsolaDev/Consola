import * as fs from 'fs';
import * as path from 'path';

/**
 * Generates a conductor's brief on disk: CLAUDE.md, POLICY.md, state.json.
 *
 * The files are the product — everything agent-deck makes users hand-author,
 * Consola writes from shipped templates, and they stay editable on disk. The
 * directory is also the future Playbook seam: name and version it later and
 * it becomes shareable with no rework.
 */

/** Directory names a conductor may have. Rejects path traversal outright. */
export const CONDUCTOR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const TEMPLATE_FILES: ReadonlyArray<{ template: string; output: string }> = [
    { template: 'CLAUDE.md.tmpl', output: 'CLAUDE.md' },
    { template: 'POLICY.md.tmpl', output: 'POLICY.md' },
    { template: 'state.json.tmpl', output: 'state.json' },
];

/**
 * Where the shipped templates live.
 *
 * The compiled build reads the copy `scripts/copy-conductor-templates.cjs`
 * places beside it in dist. Vitest (running from src) and a dev watch build
 * that has not run the copy step fall back to the source location.
 */
function templatesDir(): string {
    const candidates = [
        path.join(__dirname, 'templates'),
        path.join(__dirname, '../../../../src/main/conductor/templates'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`Conductor templates not found. Looked in: ${candidates.join(', ')}`);
}

/** Replace {{key}} placeholders. Unknown keys stay visible, not blanked. */
export function renderTemplate(source: string, values: Record<string, string>): string {
    return source.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole
    );
}

/**
 * Create `<scopePath>/conductor/<name>/` from the shipped templates.
 *
 * Refuses an existing directory rather than overwriting: the files are
 * user-editable state from the moment they land, and a name collision is a
 * fact the user has to resolve, not something to paper over.
 *
 * @returns the absolute path of the created directory.
 */
export async function scaffold(
    scopePath: string,
    name: string,
    kickoff: string,
    workspaceName: string
): Promise<string> {
    if (!CONDUCTOR_NAME_PATTERN.test(name)) {
        throw new Error(
            `Invalid conductor name "${name}": use letters, digits, dots, dashes and underscores.`
        );
    }

    const dir = path.join(scopePath, 'conductor', name);
    if (fs.existsSync(dir)) {
        throw new Error(`Conductor directory already exists: ${dir}`);
    }

    const source = templatesDir();
    const values = { name, kickoff, workspaceName };

    await fs.promises.mkdir(dir, { recursive: true });
    for (const { template, output } of TEMPLATE_FILES) {
        const raw = await fs.promises.readFile(path.join(source, template), 'utf8');
        await fs.promises.writeFile(path.join(dir, output), renderTemplate(raw, values), 'utf8');
    }
    return dir;
}
