// Consola's entry (vendor/t3code/UPSTREAM.md): re-exports the lifted Claude code
// under t3's names.
export { ClaudeDriver, type ClaudeDriverEnv } from "./provider/Drivers/ClaudeDriver.ts";
export * as ClaudeAdapterV2 from "./orchestration-v2/Adapters/ClaudeAdapterV2.ts";
export {
  CLAUDE_PROVIDER,
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "./orchestration-v2/Adapters/ClaudeAdapterV2.ts";
