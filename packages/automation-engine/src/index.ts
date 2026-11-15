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
    ItemRef,
    InboxItemView,
    ItemSnapshot,
    ActionView,
    ScopeView,
    SessionView,
    WorkspaceView,
} from './views';
export { RunStore, RETENTION_DAYS, MAX_RUNS_PER_WORKSPACE, type AddedBy, type AutomationStateFile } from './RunStore';
export type { RunHistory } from './ports';
export { recoverAfterRestart, isEngineRun, INTERRUPTED_COMMAND } from './steps/recover';
export type {
    StateFile,
    LoadedFactoryFile,
    FactoryFileHandle,
    EngineToolCaller,
    EngineToolScope,
    EngineToolContext,
    EngineToolResult,
    EngineTool,
    ToolsPort,
    AgentLaunchRequest,
    LaunchedSession,
    RunFolderPort,
} from './ports';
export { MAX_ARTIFACT_BYTES, type RunDefinition } from './steps/definition';
export {
    describeError,
    agentToolContext,
    firstActionFor,
    firstScope,
    fillActionPlaceholders,
    CONSOLA_NAMESPACE,
    StartedByHandError,
} from './support';
export { ASSIGNED_REVIEWS_NAME, yamlName, assignedReviewsEntry, EMPTY_FACTORY_FILE, factoryTemplate } from './factoryTemplates';
export {
    AutomationService,
    INTERRUPTED_PROMPT,
    TICK_MS,
    DEFAULT_MAX_CONCURRENT_AGENTS,
    MAX_WAITING_PER_SESSION,
    type AutomationServiceDeps,
    type AutomationNotice,
    type SaveEntryOptions,
} from './AutomationService';
export { resolveEventSource, scheduledPrompt, connectionCatalog, type EventSource, type ConnectionCatalogEntry } from './connections';
export { describeCapabilities, type AutomationCapabilities, type CapabilitiesInput } from './capabilities';
export { AUTOMATION_TEMPLATES, coversAssignedReviews, templateViews, type AutomationTemplate, type TemplateRequirement } from './templates';
export * from './node';
