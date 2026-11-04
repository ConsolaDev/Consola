/**
 * @consola/factory-spec — the one definition of factory.yml.
 *
 * Every runner (Consola's local runner today, the cloud runner later)
 * validates spec files with this package and records runs in its shapes, so
 * a file that loads in one loads identically in the other. Nothing here knows
 * which tools or actions exist: that is each runner's registry.
 */
export { cronError, nextCronOccurrence } from './cron';
export { parseFactorySpec, type FactorySpecIssue, type FactorySpecParseResult } from './parse';
export {
    TERMINAL_RUN_STATUSES,
    automationVersion,
    type RunnerKind,
    type RunRecord,
    type RunSource,
    type RunStatus,
    type RunTrigger,
} from './run';
export { parseRunTarget, type RunTarget } from './runTarget';
export {
    AUTOMATION_MODES,
    AUTOMATION_NAME_PATTERN,
    type Automation,
    type AutomationMode,
    type CronTrigger,
    type SpecOptions,
} from './schema';
