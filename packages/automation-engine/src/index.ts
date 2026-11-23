/**
 * The automation engine's single entry point. The core (everything outside
 * `node/`) is pure: no I/O module, no Electron. `node/` holds the adapters that
 * touch the machine, and this file re-exports them.
 */
export { advanceSeen, forgetFired, markFired, type OpenState, type SeenRecord } from './seenRecord';
export {
  filterRuns,
  NO_RUN_FILTER,
  isRunFilterNarrowed,
  type RunFilter,
  type RunListFilter,
} from './runFilter';
export { SNAPSHOT_ENDED_RUNS } from './views';
export { describeSchedule } from './describeSchedule';
export { describeEvery, describeRun, describeTriggerAsWritten } from './describeEntry';
export type {
  AutomationView,
  CheckView,
  ItemTarget,
  ItemTargetRow,
  ItemTargets,
  TemplateView,
  TemplateService,
  TemplateNeedSection,
  TemplateNeed,
  TemplatePreview,
  SavedAutomation,
  RunKind,
  RunListEntry,
  ListRunsQuery,
  ConversationTarget,
  RunListPage,
  AgentRunPreview,
  AutomationsSnapshot,
  FactoryStanding,
  EntryAgentView,
  EntryAgentsView,
  ItemRef,
  InboxItemView,
  ItemSnapshot,
  ActionView,
  ScopeView,
  SessionView,
  WorkspaceView,
  TurnInitView,
  TurnResultView,
  TurnReportView,
  TurnOutcome,
  StepTurnFile,
} from './views';
export {
  RunStore,
  RETENTION_DAYS,
  MAX_RUNS_PER_WORKSPACE,
  type AddedBy,
  type AutomationStateFile,
} from './RunStore';
export type { RunHistory } from './ports';
export { recoverAfterRestart, isEngineRun, INTERRUPTED_COMMAND } from './steps/recover';
export type {
  StateFile,
  FactoryFolderRead,
  FactoryFolderHandle,
  AppliedFactory,
  AppliedFactoryStore,
  AppliedSkill,
  EngineToolCaller,
  EngineToolScope,
  EngineToolContext,
  EngineToolResult,
  EngineTool,
  ToolsPort,
  CheckoutKind,
  AgentLaunchRequest,
  AgentHarnessQuery,
  AgentHarnessAnswer,
  LaunchedSession,
  RunFolderPort,
  WorkItemPort,
  CommandSpec,
  CommandResult,
  RunningCommand,
  CommandPort,
  ArgumentRole,
  ServerGroup,
  McpTransport,
  McpAbortReason,
  McpServerLaunch,
  McpToolInfo,
  McpCallOutcome,
  McpSession,
  McpConnectResult,
  McpClientPort,
} from './ports';
export { SERVER_ENV_ALLOW_LIST, serverFactsOf, type ServerFacts } from './servers/serverFacts';
export {
  renderStepPrompt,
  reminderPrompt,
  REMINDER_PREFIX,
  type StepPromptInput,
} from './steps/stepPrompt';
export { CONSOLA_SERVER_NAME } from './steps/turnReport';
export {
  StepIO,
  stepToolSpecs,
  STEP_TOOL_NAMES,
  STEP_ENDED,
  type StepIODeps,
  type StepToolAnswer,
  type StepToolSpec,
} from './steps/stepTools';
export {
  MAX_ARTIFACT_BYTES,
  agentRequirements,
  type AgentRequirements,
  type CallView,
  type CommandFile,
  type LogTail,
  type RunDefinition,
  type StepDetail,
  type StepsRunPreview,
} from './steps/definition';
export type { CheckoutRequest, PreparedCheckout, CheckoutPort } from './steps/checkout';
export { entryCheckoutKind, entryReadsItems, runCheckoutKind } from './steps/checkout';
export {
  LOG_CAP_BYTES,
  OUTPUT_FILE_CAP_BYTES,
  layerCommandEnv,
  parseOutputFile,
  describeFailure,
  maskSecrets,
} from './steps/commandIO';
export { withoutGitHooks } from './gitEnv';
export {
  describeError,
  agentToolContext,
  firstActionFor,
  firstScope,
  fillActionPlaceholders,
  CONSOLA_NAMESPACE,
  fallbackWorkItemTitle,
  StartedByHandError,
  SessionOpenedError,
} from './support';
export {
  ASSIGNED_REVIEWS_NAME,
  RE_REVIEW_NAME,
  yamlName,
  assignedReviewsEntry,
  reReviewEntry,
  EMPTY_FACTORY_FILE,
  factoryTemplate,
} from './factoryTemplates';
export {
  AutomationService,
  INTERRUPTED_PROMPT,
  WAITING_FOR_CHECKOUT,
  TICK_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  MAX_WAITING_PER_SESSION,
  OPEN_STATUSES,
  runAttention,
  type AutomationServiceDeps,
  type AutomationNotice,
  type SaveEntryOptions,
} from './AutomationService';
export {
  resolveEventSource,
  scheduledPrompt,
  connectionCatalog,
  workItemSource,
  type EventSource,
  type ConnectionCatalogEntry,
} from './connections';
export {
  runItemSource,
  POLL_FENCE_HEADING,
  MAX_FENCED_FIELDS,
  MAX_FENCED_CHARS,
  type ItemSource,
  type SourceItem,
} from './sources/itemSource';
export { pollSource } from './sources/pollSource';
export { resolvePrevious, previousDocument, NO_EARLIER_RUN } from './sources/previous';
export {
  AGENT_EXAMPLES,
  describeCapabilities,
  type AgentCapability,
  type AutomationCapabilities,
  type CapabilitiesInput,
} from './capabilities';
export {
  AUTOMATION_TEMPLATES,
  coversAssignedReviews,
  templateViews,
  type AutomationTemplate,
  type TemplateRequirement,
} from './templates';
export {
  PERSONAL_FACTORY,
  SecretReadError,
  type SecretBinding,
  type SecretsPort,
} from './secrets/secretsPort';
export {
  MAX_SECRET_VALUE_BYTES,
  MIN_SECRET_VALUE_CHARS,
  maskFormsOf,
  normalizeSecretValue,
} from './secrets/values';
export { readFailure, readSecrets, type SecretsRead } from './secrets/readSecrets';
export { NO_SECRETS, unboundOf, unboundProblem } from './secrets/unbound';
export { buildSecretsView, type SecretBindingView } from './secrets/secretsView';
export { RunSecrets, type HeldSecrets } from './secrets/runSecrets';
export * from './node';
export {
  readCheckResult,
  MAX_CHECK_STDOUT_BYTES,
  MAX_CHECK_ITEMS,
  MAX_CHECK_ITEM_BYTES,
  TITLE_CHARS,
  type PolledItem,
} from './sources/checkResult';
