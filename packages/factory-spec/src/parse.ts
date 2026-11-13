import { LineCounter, parseDocument } from 'yaml';
import { formatPath, nodeAt, toIssue, type FactorySpecIssue } from './issues';
import { automationSchema, fileSchema, type Automation } from './schema';

export type { FactorySpecIssue };

export interface FactorySpecParseResult {
    automations: Automation[];
    issues: FactorySpecIssue[];
}

/**
 * Parse and validate one factory.yml.
 *
 * Never throws. Each automation is validated on its own, so one bad entry
 * reports an issue while its siblings still load. A problem with the file as
 * a whole — YAML syntax, a missing `version` — loads nothing: half-reading a
 * file whose shape is unknown could run something the person did not write.
 */
export function parseFactorySpec(text: string): FactorySpecParseResult {
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, prettyErrors: false });
    const lineOf = (offset: number | undefined) =>
        offset === undefined ? undefined : lineCounter.linePos(offset).line;

    if (doc.errors.length > 0) {
        return {
            automations: [],
            issues: doc.errors.map((error) => ({
                message: firstLine(error.message),
                path: '',
                line: error.linePos?.[0]?.line ?? lineOf(error.pos?.[0]),
            })),
        };
    }

    const root: unknown = doc.toJS();
    // An empty (or comments-only) file is a valid "no automations yet".
    if (root === null || root === undefined) return { automations: [], issues: [] };

    const envelope = fileSchema.safeParse(root);
    if (!envelope.success) {
        return {
            automations: [],
            issues: envelope.error.issues.map((issue) => toIssue(issue, [], doc, lineOf)),
        };
    }

    const schema = automationSchema();
    const automations: Automation[] = [];
    const issues: FactorySpecIssue[] = [];
    const seen = new Set<string>();

    envelope.data.automations.forEach((raw, index) => {
        const base: Array<string | number> = ['automations', index];
        const name = readableName(raw);
        const line = lineOf(nodeAt(doc, base)?.range?.[0]);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                issues.push({ ...toIssue(issue, base, doc, lineOf), ...(name ? { automation: name } : {}) });
            }
            return;
        }
        if (seen.has(parsed.data.name)) {
            issues.push({
                message: `Duplicate automation name "${parsed.data.name}"; names must be unique.`,
                path: formatPath([...base, 'name']),
                line: lineOf(nodeAt(doc, [...base, 'name'])?.range?.[0]) ?? line,
                automation: parsed.data.name,
            });
            return;
        }
        seen.add(parsed.data.name);
        automations.push({ ...parsed.data, ...(line ? { line } : {}) });
    });

    return { automations, issues };
}

function readableName(raw: unknown): string | undefined {
    if (raw && typeof raw === 'object' && 'name' in raw) {
        const name = (raw as { name: unknown }).name;
        if (typeof name === 'string' && name.trim()) return name.trim();
    }
    return undefined;
}

function firstLine(message: string): string {
    return message.split('\n')[0].trim();
}
