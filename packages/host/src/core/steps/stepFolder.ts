/**
 * An agent step's folder in its sandbox: what the runner puts there before the turn (the
 * declaration and the documents the step may read), what the step tools write there (its outputs
 * and documents), and how the runner reads it back. Pure.
 *
 * The sandbox is untrusted: the agent runs there, so whatever the folder holds is data it may
 * have shaped. The step tools check every call, and the runner checks again what it reads out,
 * with the same rules (`checkOutputs`, `ARTIFACT_NAME_PATTERN`, the size of a document), so a
 * tampered file never becomes an output or a document.
 */
import {
  ARTIFACT_NAME_PATTERN,
  checkOutputs,
  type OutputType,
  type OutputValue,
} from '@consola/factory-spec';
import type { AgentStepRequest, StepDocument } from './ports.ts';
import {
  MAX_ARTIFACT_BYTES,
  type StepDeclaration,
  type StepFolderState,
  utf8Bytes,
} from './stepTools.ts';

/** The declaration the runner writes, in the step's folder. */
export const DECLARATION_FILE = 'declaration.json';
/** The outputs set so far, as one JSON object, in the step's folder. */
export const OUTPUTS_FILE = 'outputs.json';
/** A document the step wrote, in the step's folder. */
export const artifactFile = (name: string): string => `artifacts/${name}.md`;

/** The most `outputs.json` may hold that the runner reads; past it, no output is taken. */
export const MAX_OUTPUTS_FILE_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** What the runner declares for an attempt, from its request. */
export function declarationOf(
  request: Pick<
    AgentStepRequest,
    'outputs' | 'allowedArtifacts' | 'requiredArtifacts' | 'readable'
  >,
): StepDeclaration {
  return {
    outputs: request.outputs,
    writable: [...request.allowedArtifacts],
    required: [...request.requiredArtifacts],
    readable: request.readable.map(({ name, content }) => ({ name, content })),
  };
}

const OUTPUT_TYPES = new Set(['enum', 'integer', 'number', 'boolean', 'string']);

const isOutputType = (value: unknown): value is OutputType => {
  if (!isRecord(value) || typeof value.type !== 'string' || !OUTPUT_TYPES.has(value.type)) {
    return false;
  }
  if (value.type === 'enum') {
    return Array.isArray(value.values) && value.values.every((each) => typeof each === 'string');
  }
  if (value.type === 'string') return typeof value.maxLength === 'number';
  return true;
};

const isNameList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === 'string');

/**
 * Reads `declaration.json`, as the step tools do before every call: null when it is not one the
 * runner writes. Document names it lists are kept only when they are document names.
 */
export function readDeclaration(text: string): StepDeclaration | null {
  const json = parseJson(text);
  if (!isRecord(json)) return null;
  const { outputs, writable, required, readable } = json;
  if (!isRecord(outputs) || !Object.values(outputs).every(isOutputType)) return null;
  if (!isNameList(writable) || !isNameList(required) || !Array.isArray(readable)) return null;
  const documents: StepDocument[] = [];
  for (const each of readable) {
    if (!isRecord(each) || typeof each.name !== 'string' || typeof each.content !== 'string') {
      return null;
    }
    documents.push({ name: each.name, content: each.content });
  }
  const names = (list: string[]) => list.filter((name) => ARTIFACT_NAME_PATTERN.test(name));
  return {
    outputs: outputs as Record<string, OutputType>,
    writable: names(writable),
    required: names(required),
    readable: documents,
  };
}

/** The outputs in `outputs.json` that pass their declared types; the rest are dropped. */
const validOutputs = (
  declaration: StepDeclaration,
  text: string | null,
): { readonly outputs: Record<string, OutputValue>; readonly problems: string[] } => {
  if (text === null) return { outputs: {}, problems: [] };
  if (utf8Bytes(text) > MAX_OUTPUTS_FILE_BYTES) {
    return { outputs: {}, problems: [`${OUTPUTS_FILE} is over ${MAX_OUTPUTS_FILE_BYTES} bytes`] };
  }
  const json = parseJson(text);
  if (!isRecord(json)) return { outputs: {}, problems: [`${OUTPUTS_FILE} is not a JSON object`] };
  const { valid, problems } = checkOutputs({ ...declaration.outputs }, json);
  return { outputs: valid, problems };
};

/**
 * What the step tools find in the folder before a call: the outputs that pass their types and
 * the documents of names the step writes. A file that is not there, or not what it should be, is
 * nothing.
 */
export function folderStateOf(
  declaration: StepDeclaration,
  outputsText: string | null,
  artifacts: ReadonlyArray<{ readonly name: string; readonly text: string | null }>,
): StepFolderState {
  const written: Record<string, string> = {};
  for (const { name, text } of artifacts) {
    if (text !== null && declaration.writable.includes(name)) written[name] = text;
  }
  return { outputs: validOutputs(declaration, outputsText).outputs, artifacts: written };
}

/** What the runner takes from an attempt's folder, once it has checked it again itself. */
export type CheckedStepFolder = {
  /** The outputs that pass their declared types. */
  readonly outputs: Readonly<Record<string, OutputValue>>;
  /** The documents of names the step writes, each text within the size a document may have. */
  readonly artifacts: ReadonlyArray<StepDocument>;
  /** What it refused, for the runner's log: never a value. */
  readonly refused: ReadonlyArray<string>;
};

/**
 * The runner's own check of what it read out of the folder, with the step tools' rules: an
 * output must pass its declared type, and a document must be one the step writes
 * (`ARTIFACT_NAME_PATTERN` and the request's names) and hold at most `MAX_ARTIFACT_BYTES`.
 */
export function checkStepFolder(
  declaration: StepDeclaration,
  outputsText: string | null,
  artifacts: ReadonlyArray<{ readonly name: string; readonly text: string | null }>,
): CheckedStepFolder {
  const { outputs, problems } = validOutputs(declaration, outputsText);
  const refused: string[] = problems.map((problem) =>
    // A problem quotes what was written, which the agent chose: only its output's name is kept.
    problem.replace(/ \(got .*\)$/, ''),
  );
  const documents: StepDocument[] = [];
  for (const { name, text } of artifacts) {
    if (text === null) continue;
    if (!ARTIFACT_NAME_PATTERN.test(name) || !declaration.writable.includes(name)) {
      refused.push(
        `a document named ${JSON.stringify(name.slice(0, 64))}, which the step does not write`,
      );
      continue;
    }
    if (utf8Bytes(text) > MAX_ARTIFACT_BYTES) {
      refused.push(`${name}, which holds more than ${MAX_ARTIFACT_BYTES / 1024} KB`);
      continue;
    }
    documents.push({ name, content: text });
  }
  return { outputs, artifacts: documents, refused };
}

/** What a step has left unset: declared outputs without a valid value, required documents not written. */
export type MissingFromStep = {
  readonly outputs: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<string>;
};

export function missingFrom(
  declaration: StepDeclaration,
  checked: CheckedStepFolder,
): MissingFromStep {
  const written = new Set(checked.artifacts.map((document) => document.name));
  return {
    outputs: Object.keys(declaration.outputs).filter(
      (name) => !Object.prototype.hasOwnProperty.call(checked.outputs, name),
    ),
    artifacts: declaration.required.filter((name) => !written.has(name)),
  };
}

export const nothingMissing = (missing: MissingFromStep): boolean =>
  missing.outputs.length === 0 && missing.artifacts.length === 0;

/** "a", "a and b", "a, b and c". */
const listed = (names: ReadonlyArray<string>): string =>
  names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The sentence a step fails with when it ended without what it must leave, after its reminder. */
export function missingSentence(missing: MissingFromStep): string {
  const parts = [
    ...(missing.outputs.length > 0
      ? [
          `${missing.outputs.length === 1 ? 'the output' : 'the outputs'} ${listed(missing.outputs)}`,
        ]
      : []),
    ...(missing.artifacts.length > 0
      ? [
          `${missing.artifacts.length === 1 ? 'the document' : 'the documents'} ${listed(missing.artifacts)}`,
        ]
      : []),
  ];
  return `The step ended without ${parts.join(' and ')}, even after its reminder.`;
}
