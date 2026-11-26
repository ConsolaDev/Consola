// @effect-diagnostics nodeBuiltinImport:off - The server reads stdin and the step's folder, and writes stdout and the folder.
/**
 * The step tools' MCP server (`consola-host step-tools --folder <dir>`), which an agent step's CLI
 * starts in its sandbox, the one server of the MCP config the runner writes there (`stepMcpConfig`,
 * `--strict-mcp-config --mcp-config`). It speaks MCP on stdio (`core/steps/mcpMessages.ts`)
 * and answers each call from the attempt's folder (`core/steps/stepTools.ts`): the declaration the
 * runner wrote, then the outputs and documents earlier calls wrote. Writes replace a file whole,
 * by a rename, so the runner never reads half of one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  callToolResult,
  initializeResult,
  listToolsResult,
  mcpError,
  pingResult,
  readMcpLine,
  unknownMethod,
} from '../core/steps/mcpMessages.ts';
import {
  artifactFile,
  DECLARATION_FILE,
  folderStateOf,
  OUTPUTS_FILE,
  readDeclaration,
} from '../core/steps/stepFolder.ts';
import { callStepTool, stepToolListings } from '../core/steps/stepTools.ts';
import type { StepDeclaration, StepToolAnswer } from '../core/steps/stepTools.ts';

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Writes `file` whole: a temporary file beside it, then a rename over it. */
const replaceFile = (file: string, content: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, file);
};

const NO_DECLARATION: StepToolAnswer = {
  text: "This step's declaration cannot be read, so its tools cannot answer.",
  isError: true,
};

/** Answers one tool call from `folder`, writing what it changes. */
export function answerStepToolCall(folder: string, name: string, args: unknown): StepToolAnswer {
  const declarationText = readText(join(folder, DECLARATION_FILE));
  const declaration = declarationText === null ? null : readDeclaration(declarationText);
  if (declaration === null) return NO_DECLARATION;
  const state = folderStateOf(
    declaration,
    readText(join(folder, OUTPUTS_FILE)),
    declaration.writable.map((each) => ({
      name: each,
      text: readText(join(folder, artifactFile(each))),
    })),
  );
  const effect = callStepTool(declaration, state, name, args);
  try {
    if (effect.outputs !== undefined) {
      replaceFile(join(folder, OUTPUTS_FILE), `${JSON.stringify(effect.outputs)}\n`);
    }
    if (effect.artifact !== undefined) {
      replaceFile(join(folder, artifactFile(effect.artifact.name)), effect.artifact.content);
    }
  } catch {
    return { text: 'Consola could not keep what this call set; call it again.', isError: true };
  }
  return effect.answer;
}

const listingsOf = (folder: string): ReturnType<typeof stepToolListings> | null => {
  const text = readText(join(folder, DECLARATION_FILE));
  const declaration: StepDeclaration | null = text === null ? null : readDeclaration(text);
  return declaration === null ? null : stepToolListings(declaration);
};

/** Serves MCP on `input` and `output` until `input` ends. */
export function serveStepTools(folder: string, input: Readable, output: Writable): Promise<void> {
  const send = (message: unknown) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    const request = readMcpLine(line);
    switch (request.kind) {
      case 'quiet':
        return;
      case 'invalid':
        return send(mcpError(request.id, request.problem));
      case 'unknown-method':
        return send(unknownMethod(request.id, request.method));
      case 'initialize':
        return send(initializeResult(request.id, request.protocolVersion));
      case 'ping':
        return send(pingResult(request.id));
      case 'list-tools': {
        const listings = listingsOf(folder);
        return send(
          listings === null
            ? mcpError(request.id, NO_DECLARATION.text, -32_603)
            : listToolsResult(request.id, listings),
        );
      }
      case 'call-tool':
        return send(
          callToolResult(request.id, answerStepToolCall(folder, request.name, request.arguments)),
        );
    }
  });
  return new Promise((resolve) => lines.once('close', () => resolve()));
}
