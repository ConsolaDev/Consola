/**
 * The engine's pure core, as a runner that brings its own I/O imports it
 * (`@consola/automation-engine/core`): the step sequencer, the step records'
 * changes, a step's prompt and its command's environment, and the checks of
 * what a step left. Unlike `index.ts` it never reaches `src/node/`, so
 * importing it loads no adapter, no MCP SDK and nothing that touches the
 * machine. It holds only `export … from`.
 */
export {
  advanceSteps,
  type Advance,
  type Lane,
  type StepUpdate,
} from './steps/sequence';
export {
  closeSteps,
  isLoopRow,
  stepRecordsOf,
  withAttemptStarted,
  withGateAsked,
  withRound,
  withStep,
  withUpdate,
} from './steps/stepRecords';
export { agentStepLaunch, endedWithout, stepCap, type AgentStepLaunch } from './steps/agentStep';
export {
  commandOutcome,
  prepareCommand,
  withCommandIntent,
  type CommandOutcome,
  type PreparedCommand,
} from './steps/commandStep';
export {
  describeFailure,
  lastLineOf,
  maskSecrets,
  OUTPUT_FILE_CAP_BYTES,
} from './steps/commandIO';
export { reminderPrompt, renderStepPrompt, type StepPromptInput } from './steps/stepPrompt';
export { requiredOf, writableOf } from './steps/stepTools';
export { runCostOf } from './steps/turnReport';
export {
  agentRequirements,
  MAX_ARTIFACT_BYTES,
  type AgentRequirements,
  type RunDefinition,
} from './steps/definition';
export { resolveWebhookTrigger, type FilterFacts } from './connections';
export type { ItemSource } from './sources/itemSource';
export type { CheckoutKind, CommandResult, RunFolderPort } from './ports';
export { maskFormsOf } from './secrets/values';
