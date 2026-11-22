// Consola's entry (vendor/t3code/UPSTREAM.md): re-exports t3's Claude driver and
// adapter from the lifted server files, under t3's names.
export { ClaudeDriver, type ClaudeDriverEnv } from "t3/provider/Drivers/ClaudeDriver.ts";
export * as ClaudeAdapterV2 from "t3/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
export {
  CLAUDE_PROVIDER,
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "t3/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
