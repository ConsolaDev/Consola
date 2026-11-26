import { MAX_ARTIFACT_BYTES } from '@consola/automation-engine/core';
import type { RunFolderPort } from '@consola/automation-engine/core';

/**
 * One run's documents, held in memory while the runner walks it: what its steps wrote (each
 * agent step's handover and `artifacts:`, a command's kept stdout) and the files the engine's
 * command functions read and write as they decide (`$CONSOLA_OUTPUT`, `outputs.json`).
 *
 * It is a `RunFolderPort`, the engine's run folder, so the engine's own `agentStepLaunch`,
 * `prepareCommand` and `commandOutcome` decide a cloud step exactly as they decide a desktop one,
 * over paths that name nothing on this machine: `documents/<step>/<attempt>/<name>.md` and
 * `steps/<step>/<attempt>/<file>`. A document's path is what a `{{steps.x.y.file}}` value renders
 * to; the ring hands that file to the step's sandbox (`CommandStepRequest.files`) and its absolute
 * path there to the variable (`fileEnv`). What only the desktop has (polls' items, skills, turn
 * files, sweeps) throws if it is ever reached.
 *
 * A restart loses it with the run: a run that survives a runner restart mid-step is later work.
 */
export class RunDocuments {
  private readonly texts = new Map<string, string>();
  /** Every document path `artifactPath` handed out: the values a command's `env:` may hold whole. */
  private readonly handedOut = new Set<string>();
  readonly folder: RunFolderPort;

  constructor() {
    const unavailable = (what: string) => (): never => {
      throw new Error(`A cloud runner keeps no ${what}.`);
    };
    const attemptDir = (stepId: string, attempt: number) => `steps/${stepId}/${attempt}`;
    const artifactPath = (
      stepId: string,
      attempt: number,
      name: string,
      format?: 'json' | 'text',
    ): string => {
      const extension = format === 'json' ? '.json' : format === 'text' ? '.txt' : '.md';
      const path = `${DOCUMENTS}/${stepId}/${attempt}/${name}${extension}`;
      this.handedOut.add(path);
      return path;
    };
    this.folder = {
      workspaceDir: unavailable('workspace folder'),
      checkFiles: unavailable("poll's check files"),
      writeItem: unavailable("poll's item"),
      readItem: unavailable("poll's item"),
      latestAttempt: unavailable('attempt folders'),
      itemPath: unavailable("poll's item"),
      runDir: unavailable('run folder'),
      attemptDir: (_workspaceId, _runId, stepId, attempt) => attemptDir(stepId, attempt),
      skillsDir: unavailable('skills'),
      writeSkills: unavailable('skills'),
      readSkills: unavailable('skills'),
      writeDefinition: unavailable('definition file'),
      readDefinition: unavailable('definition file'),
      writeArtifact: (_workspaceId, _runId, stepId, attempt, name, content, format) => {
        const bytes = utf8Bytes(content);
        if (bytes > MAX_ARTIFACT_BYTES) {
          throw new Error(
            `${name} is ${bytes} bytes of UTF-8; a document holds at most ${MAX_ARTIFACT_BYTES / 1024} KB.`,
          );
        }
        this.texts.set(artifactPath(stepId, attempt, name, format), content);
        return { bytes };
      },
      artifactPath: (_workspaceId, _runId, stepId, attempt, name, format) =>
        artifactPath(stepId, attempt, name, format),
      readArtifact: (_workspaceId, _runId, stepId, attempt, name) =>
        this.texts.get(`${DOCUMENTS}/${stepId}/${attempt}/${name}.md`) ?? null,
      writeJson: (dir, file, value) => {
        this.texts.set(`${dir}/${file}`, JSON.stringify(value));
      },
      writeMaterial: unavailable("run's own checkout"),
      appendTurn: unavailable('turn files'),
      tail: unavailable('logs'),
      readText: (file, maxBytes) => {
        const text = this.texts.get(file);
        if (text === undefined) return null;
        if (utf8Bytes(text) > maxBytes) throw new Error(`${file} is over ${maxBytes} bytes.`);
        return text;
      },
      ensureEmptyFile: (file) => {
        this.texts.set(file, '');
      },
      writeText: (file, text) => {
        this.texts.set(file, text);
      },
      exists: (file) => this.texts.has(file),
      sweep: unavailable('run folders'),
      sweepChecks: unavailable("poll's check files"),
      removeAll: unavailable('run folders'),
    };
  }

  /** Keeps one of a step's documents for an attempt, replacing it; throws over the engine's cap. */
  write(stepId: string, attempt: number, name: string, content: string): { bytes: number } {
    return this.folder.writeArtifact('', '', stepId, attempt, name, content);
  }

  /** One of a step's documents at an attempt, or null when it wrote none by that name. */
  read(stepId: string, attempt: number, name: string): string | null {
    return this.folder.readArtifact('', '', stepId, attempt, name);
  }

  /** Writes a file the engine's command functions read (`$CONSOLA_OUTPUT`, the stdout log). */
  put(file: string, text: string): void {
    this.texts.set(file, text);
  }

  /** Whether `path` is a document's path a `.file` value rendered to, and if so its text. */
  documentAt(path: string): string | null {
    return this.handedOut.has(path) ? (this.texts.get(path) ?? null) : null;
  }

  /** The document paths `value` holds inside other text: a `.file` value that is not the whole value. */
  pathsInside(value: string): string[] {
    return [...this.handedOut].filter((path) => value !== path && value.includes(path));
  }
}

/** Where every document's path starts. */
const DOCUMENTS = 'documents';

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
