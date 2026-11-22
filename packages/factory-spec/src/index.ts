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
export { cronError, nextCronOccurrence } from './cron';
export { parseAutomationFile, type AutomationFileResult } from './automationFile';
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
  type FactoryFiles,
  type FactoryNotice,
  type FactoryParseResult,
} from './factory';
export { parseFactorySpec, type FactorySpecIssue, type FactorySpecParseResult } from './parse';
export {
  hasTemplateBraces,
  parseTemplate,
  renderTemplate,
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
  ENV_PREFIX_EXCEPTIONS,
  GATE_CHOICE_PATTERN,
  gateChoices,
  isRefusedEnvName,
  LATER_KEYS,
  MAX_GATE_ASK,
  MAX_GATE_SHOW,
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
  type AgentStep,
  type CommandStep,
  type GateStep,
  type ItemField,
  type ItemFieldTable,
  type Step,
} from './steps';
