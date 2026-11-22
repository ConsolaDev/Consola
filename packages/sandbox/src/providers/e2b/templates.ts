import { join } from 'node:path';
import { Template } from 'e2b';
import { translate } from './errors';

/**
 * A template, as Consola writes one: a folder under `packages/sandbox/templates/` holding a
 * `Dockerfile`, which is also the context its COPY reads. A Dockerfile is the one image format
 * every provider builds from, so a template outlives a change of provider; only building it is
 * E2B's.
 */
export interface E2BTemplateBuild {
  /** Consola's E2B API key, as the provider takes it. */
  readonly apiKey: string;
  /** The template's name, which `create` then takes as `template`. */
  readonly name: string;
  /** The template's folder, holding its `Dockerfile`. */
  readonly folder: string;
  /** Hears the build's log, a line at a time. */
  readonly onLog?: (line: string) => void;
}

export interface E2BTemplateBuilt {
  readonly name: string;
  readonly templateId: string;
  readonly buildId: string;
}

/**
 * Builds the template in `folder` on Consola's E2B account, under `name`; building again
 * replaces it. E2B reads a Dockerfile of one stage, with RUN, COPY, ADD, WORKDIR, USER, ENV,
 * ARG, CMD and ENTRYPOINT, and its ENV reaches every command. Fails as a `SandboxError` in
 * E2B's words, never the key.
 */
export async function buildE2BTemplate(build: E2BTemplateBuild): Promise<E2BTemplateBuilt> {
  try {
    const template = e2bTemplateFrom(build.folder);
    const built = await Template.build(template, build.name, {
      apiKey: build.apiKey,
      onBuildLogs: (entry) => build.onLog?.(entry.toString()),
    });
    return { name: build.name, templateId: built.templateId, buildId: built.buildId };
  } catch (error) {
    throw translate(error, build.apiKey);
  }
}

/** The template in `folder`, read as E2B reads it, without building it. */
export function e2bTemplateFrom(folder: string) {
  return Template({ fileContextPath: folder }).fromDockerfile(join(folder, 'Dockerfile'));
}
