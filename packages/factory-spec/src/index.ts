/**
 * @consola/factory-spec — the one definition of factory.yml.
 *
 * Every runner (Consola's local runner today, the cloud runner later)
 * validates spec files with this package and records runs in its shapes, so
 * a file that loads in one loads identically in the other. Nothing here knows
 * which tools, actions, connections or events exist: that is each runner's
 * registry.
 */
export {
  HARNESS_ID_PATTERN,
  MAX_AGENT_BODY_BYTES,
  MAX_AGENT_SERVERS,
  MAX_AGENT_SKILLS,
  TOOL_NAME_PATTERN,
  agentHash,
  parseAgentFile,
  type AgentDefinition,
  type AgentServer,
  type ParsedAgent,
} from './agents';
export {
  BRANCH_PLACEHOLDERS,
  branchPlaceholderNames,
  branchTemplateProblem,
  cleanBranchPart,
  refFormatProblem,
  renderBranch,
  type BranchValues,
} from './branchName';
export {
  MAX_ENVIRONMENT_ENTRIES,
  environmentHash,
  looksLikeCredential,
  parseEnvironmentFile,
  type EnvironmentDefinition,
} from './environments';
export {
  MAX_REPOS,
  REPO_PATTERN,
  isItemCheckout,
  isRunOwnedCheckout,
  type EntryCheckout,
  type RunOwnedCheckout,
} from './flow';
export { cronError, nextCronOccurrence } from './cron';
export { parseAutomationFile, type AutomationFileResult } from './automationFile';
export { automationLines, type AutomationLines, type LineRange } from './lines';
export {
  appendAutomationEntry,
  automationEntryText,
  automationFileText,
  automationItemText,
  replaceAutomationEntry,
} from './edit';
export {
  MAX_IF_LENGTH,
  checkExpression,
  evaluateExpression,
  expressionPaths,
  parseExpression,
  type CompareOp,
  type Expr,
  type ExprType,
  type ExprValue,
  type ExpressionScope,
  type PathExpr,
} from './expression';
export {
  checkOutputs,
  coerceOutput,
  describeOutputType,
  type OutputType,
  type OutputValue,
} from './outputs';
export { FIELD_NAME_PATTERN, parseFieldPath, readFieldPath, type FieldPath } from './fieldPath';
export {
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_TIMEOUT_MS,
  MAX_POLL_EVERY_MS,
  MIN_POLL_EVERY_MS,
  RESERVED_TRIGGER_NAMES,
  type ManualTrigger,
  type PollTrigger,
} from './poll';
export { parseAutomationEntry, type AutomationEntryResult } from './entry';
export {
  LATER_FOLDERS,
  MAX_FACTORY_TEXT_BYTES,
  factoryFilesOf,
  isIgnoredFileName,
  parseFactory,
  storedFactoryFiles,
  type FactoryFiles,
  type FactoryNotice,
  type FactoryParseResult,
} from './factory';
export { parseFactorySpec, type FactorySpecIssue, type FactorySpecParseResult } from './parse';
export {
  AGENT_SECRETS_REASON,
  ENTRY_SECRETS_REASON,
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRETS_PER_PLACE,
  parseSecretNames,
  secretNameProblem,
  secretNamesOf,
  secretTemplateReason,
  secretUsesOf,
  type SecretPlace,
  type SecretUse,
} from './secrets';
export {
  MAX_SERVER_ARGS,
  MAX_SERVERS,
  MCP_SERVER_NAME_PATTERN,
  parseMcpServers,
  serverHash,
  unpinnedLauncher,
  type McpServerDefinition,
  type ServersParse,
} from './servers';
export {
  hasTemplateBraces,
  parseTemplate,
  renderTemplate,
  secretPathProblem,
  templatePaths,
  type TemplatePart,
  type TemplatePath,
} from './template';
export {
  TERMINAL_RUN_STATUSES,
  automationVersion,
  stableStringify,
  stepsResolvedBody,
  type RunItem,
  type RunnerKind,
  type RunRecord,
  type RunSource,
  type RunStatus,
  type RunTrigger,
  type StepRun,
  type StepRunStatus,
} from './run';
export { isAgentRun, parseToolRef, type AgentRunTarget, type RunTarget } from './runTarget';
export {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  SKILL_TEXT_EXTENSIONS,
  parseSkill,
  skillHash,
  type SkillDefinition,
  type SkillFileEntry,
} from './skills';
export {
  AUTOMATION_MODES,
  AUTOMATION_NAME_PATTERN,
  CONNECTION_ID_PATTERN,
  EVENT_NAME_PATTERN,
  isStepsEntry,
  PR_ITEM_NEEDS_PRS,
  type Automation,
  type AutomationMode,
  type CronTrigger,
  type EventTrigger,
  type StepsAutomation,
  type Trigger,
} from './schema';
export {
  ARTIFACT_NAME_PATTERN,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_STRING_MAX,
  ENV_NAME_PATTERN,
  REFUSED_ENV_NAMES,
  REFUSED_ENV_PREFIXES,
  CHECKOUT_CHANGES_REF,
  ENV_PREFIX_EXCEPTIONS,
  GH_IDENTITY_ENV_REASON,
  flatSteps,
  GATE_CHOICE_PATTERN,
  gateChoices,
  isRefusedEnvName,
  LATER_KEYS,
  leafSteps,
  MAX_GATE_ASK,
  MAX_GATE_SHOW,
  MAX_LOOP_STEPS,
  MAX_RETRIES,
  MAX_ROUNDS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_OUTPUTS,
  MAX_STEPS,
  MAX_TURNS_LIMIT,
  OUTPUT_NAME_PATTERN,
  parseReadRef,
  STEP_ID_PATTERN,
  STRING_MAX_CEILING,
  stepItemFieldProblems,
  stepItemFields,
  stepsSchema,
  TRUSTED_ITEM_FIELDS,
  type AgentStep,
  type CommandStep,
  type FlatStep,
  type GateStep,
  type ItemField,
  type ItemFieldTable,
  type OnExhausted,
  type RepeatStep,
  type Step,
  type UsesStep,
  type StepEntry,
} from './steps';
export {
  callArguments,
  interpretedNotice,
  usesNotices,
  type ArgumentTrust,
  type CallArgument,
  type ValueSource,
} from './callArguments';
export {
  DEFAULT_CALL_TIMEOUT_MS,
  ENTRY_USES_REASON,
  MAX_CALL_TIMEOUT_MS,
  USES_REF_PATTERN,
  usesTexts,
} from './uses';
