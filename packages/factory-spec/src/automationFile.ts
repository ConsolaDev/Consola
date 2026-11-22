/**
 * `automations/<name>.yaml`: one automation per file, written as a
 * `factory.yml` entry is, at the top level of the document, with the same
 * keys and rules. Its name is the file's, so any entry moves into a file of
 * its own with no change but removing `name:`.
 */
import { LineCounter, parseDocument } from 'yaml';
import { closestNode, toIssue, type FactorySpecIssue } from './issues';
import { AUTOMATION_NAME_PATTERN } from './names';
import { automationSchema, type Automation } from './schema';

export interface AutomationFileResult {
  /** Present only when there are no issues: named after the file, with its `file` and `line: 1`. */
  automation?: Automation;
  /** Each with `file` and `automation`, and a path from the file's root (`steps[0].agent`). */
  issues: FactorySpecIssue[];
  /** The YAML does not parse, or its root is not a mapping: nothing in the file was read. */
  unreadable: boolean;
  /** The 1-based line of the node at `path` (from the file's root), or of its nearest ancestor. */
  lineAt(path: Array<string | number>): number | undefined;
}

const ROOT =
  'Expected an automation: a mapping of its keys (`on:`, `steps:` and the rest), with no `name:`.';
const NAMED = "The file's name is the automation's name: remove `name:`, or rename the file.";
const VERSIONED = '`version` belongs to factory.yml.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate one automation file. `fileName` is its name without `.yaml`. Never throws. */
export function parseAutomationFile(fileName: string, text: string): AutomationFileResult {
  const file = `automations/${fileName}.yaml`;
  if (!AUTOMATION_NAME_PATTERN.test(fileName)) {
    return {
      issues: [
        {
          message: `\`${file}\`: an automation's file name is its name: lowercase letters, digits and dashes, e.g. automations/investigate-alerts.yaml.`,
          path: '',
          file,
        },
      ],
      unreadable: false,
      lineAt: () => undefined,
    };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (offset: number | undefined) =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;
  const lineAt = (path: Array<string | number>) => lineOf(closestNode(doc, path)?.range?.[0]);
  const ours = (issue: FactorySpecIssue): FactorySpecIssue => ({
    ...issue,
    file,
    automation: fileName,
  });

  if (doc.errors.length > 0) {
    return {
      issues: doc.errors.map((error) =>
        ours({
          message: error.message.split('\n')[0].trim(),
          path: '',
          line: error.linePos?.[0]?.line ?? lineOf(error.pos?.[0]) ?? 1,
        }),
      ),
      unreadable: true,
      lineAt,
    };
  }
  const root: unknown = doc.toJS();
  if (!isRecord(root)) {
    return { issues: [ours({ message: ROOT, path: '', line: 1 })], unreadable: true, lineAt };
  }

  const issues: FactorySpecIssue[] = [];
  const { name: _name, version: _version, ...entry } = root;
  if (Object.prototype.hasOwnProperty.call(root, 'name'))
    issues.push({ message: NAMED, path: 'name', line: lineAt(['name']) });
  if (Object.prototype.hasOwnProperty.call(root, 'version'))
    issues.push({ message: VERSIONED, path: 'version', line: lineAt(['version']) });
  const parsed = automationSchema().safeParse({ name: fileName, ...entry });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push(toIssue(issue, [], doc, lineOf));
  }
  if (issues.length > 0 || !parsed.success) {
    return { issues: issues.map(ours), unreadable: false, lineAt };
  }
  return { automation: { ...parsed.data, file, line: 1 }, issues: [], unreadable: false, lineAt };
}
