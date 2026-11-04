import { z } from 'zod';
import { cronError } from './cron';
import { parseRunTarget, type RunTarget } from './runTarget';

/**
 * `auto` runs as soon as the trigger fires. `confirm` previews and waits for
 * a person to approve. `notify` previews and reports, changing nothing.
 * `confirm` is the default: anything a person did not click asks first.
 */
export const AUTOMATION_MODES = ['auto', 'confirm', 'notify'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

/** Names are identifiers people type into `run_automation` and see in history. */
export const AUTOMATION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The only trigger the local runner has today. `github:` and `cloud:` come next. */
export interface CronTrigger {
    kind: 'cron';
    cron: string;
}

export interface Automation {
    name: string;
    trigger: CronTrigger;
    run: RunTarget;
    /** Arguments for the target. Validated by the runner, which knows the target's schema. */
    with: Record<string, unknown>;
    mode: AutomationMode;
    /** 1-based line of the entry in the file, for error and UI pointers. */
    line?: number;
}

export interface SpecOptions {
    /**
     * Whether bare-name `run:` targets (agent actions) are accepted. The local
     * runner does not start agents from automations yet, so it says false
     * and the entry fails validation with a reason instead of loading inert.
     */
    allowActions: boolean;
}

const triggerSchema = z.record(z.unknown()).superRefine((on, ctx) => {
    const kinds = Object.keys(on);
    if (kinds.length !== 1 || kinds[0] !== 'cron') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
                'Expected exactly one trigger, `cron`. Other triggers (github, cloud, session) ' +
                `are not supported by the local runner yet; got: ${kinds.join(', ') || 'none'}.`,
        });
        return;
    }
    if (typeof on.cron !== 'string') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cron'],
            message: 'Expected a quoted cron expression, e.g. "0 9 * * *".',
        });
        return;
    }
    const problem = cronError(on.cron);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cron'], message: problem });
});

export function automationSchema(options: SpecOptions) {
    return z
        .object({
            name: z
                .string()
                .regex(
                    AUTOMATION_NAME_PATTERN,
                    'Use lowercase letters, digits and dashes, e.g. clean-up-stale-sessions.'
                ),
            on: triggerSchema,
            run: z.string().superRefine((ref, ctx) => {
                const target = parseRunTarget(ref);
                if (!target) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: `"${ref}" is not a tool reference (namespace#tool) or an action name.`,
                    });
                } else if (target.kind === 'action' && !options.allowActions) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            `Actions (bare names like "${ref}") cannot be run by automations yet. ` +
                            'Name a tool instead, e.g. consola#cleanup_stale_sessions.',
                    });
                }
            }),
            with: z.record(z.unknown()).default({}),
            mode: z.enum(AUTOMATION_MODES).default('confirm'),
            // A file belongs to one workspace, so there is nothing to select.
            // Named rather than left to `strict()`, whose "unrecognized key"
            // would not say why.
            workspace: z
                .never({
                    errorMap: () => ({
                        message: 'Not needed: this file belongs to one workspace, and its automations act only on it.',
                    }),
                })
                .optional(),
        })
        .strict()
        .transform(
            (entry): Automation => ({
                name: entry.name,
                trigger: { kind: 'cron', cron: (entry.on.cron as string).trim() },
                run: parseRunTarget(entry.run)!,
                with: entry.with,
                mode: entry.mode,
            })
        );
}

/**
 * The envelope. Strict on purpose: a typo'd top-level key would otherwise
 * be silently ignored, and an automation that never loads looks exactly like
 * one that has not fired yet.
 */
export const fileSchema = z
    .object({
        version: z.literal(1, {
            errorMap: () => ({ message: 'Expected `version: 1` at the top of the file.' }),
        }),
        automations: z.array(z.unknown()).default([]),
    })
    .strict();
