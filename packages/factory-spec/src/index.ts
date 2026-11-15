/**
 * @consola/factory-spec — the one definition of factory.yml.
 *
 * Every runner (Consola's local runner today, the cloud runner later)
 * validates spec files with this package and records runs in its shapes, so
 * a file that loads in one loads identically in the other. Nothing here knows
 * which tools, actions, connections or events exist: that is each runner's
 * registry.
 */
export { cronError, nextCronOccurrence } from './cron';
export { appendAutomationEntry, automationEntryText, replaceAutomationEntry } from './edit';
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
export { parseAutomationEntry, type AutomationEntryResult } from './entry';
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
    MAX_COMMAND_TIMEOUT_MS,
    MAX_OUTPUTS,
    MAX_STEPS,
    OUTPUT_NAME_PATTERN,
    STEP_ID_PATTERN,
    STRING_MAX_CEILING,
    stepItemFieldProblems,
    stepItemFields,
    stepsSchema,
    type AgentStep,
    type CommandStep,
    type ItemField,
    type ItemFieldTable,
    type Step,
} from './steps';
