/**
 * The automation engine's single entry point. The core (everything outside
 * `node/`) is pure: no I/O module, no Electron. `node/` holds the adapters that
 * touch the machine, and this file re-exports them.
 */
export { advanceSeen, type SeenRecord } from './seenRecord';
export { describeSchedule } from './describeSchedule';
export { describeRun, describeTriggerAsWritten } from './describeEntry';
export type {
    AutomationView,
    TemplateView,
    TemplateService,
    TemplateNeedSection,
    TemplateNeed,
    TemplatePreview,
    SavedAutomation,
    RunKind,
    RunListEntry,
    AgentRunPreview,
    AutomationsSnapshot,
} from './views';
export { RunStore, RETENTION_DAYS, MAX_RUNS_PER_WORKSPACE, type RunHistory, type AddedBy, type AutomationStateFile } from './RunStore';
export type { StateFile, LoadedFactoryFile, FactoryFileHandle } from './ports';
export { ASSIGNED_REVIEWS_NAME, yamlName, assignedReviewsEntry, EMPTY_FACTORY_FILE, factoryTemplate } from './factoryTemplates';
export * from './node';
