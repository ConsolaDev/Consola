// Consola's file (vendor/t3code/UPSTREAM.md, "Lifted by Consola"). The
// ingestion and projection tests live in the lifted server tree, which `test`
// runs from (`--dir .` in apps/server). They are named one by one, as paths
// under it: their file names have no common prefix. The list is disjoint from
// provider-claude's glob (`{Claude,claude}*.test.ts`) and provider-codex's
// (`{Codex,codex}*.test.ts`): no name below starts with either. The server's
// own config supplies the tests that are not run here.
import serverConfig from "../../apps/server/vitest.config.ts";

export default {
  ...serverConfig,
  test: {
    ...serverConfig.test,
    include: [
      "src/orchestration-v2/EventSink.test.ts",
      "src/orchestration-v2/ProjectionControlReads.test.ts",
      "src/orchestration-v2/ProjectionMaintenance.test.ts",
      "src/orchestration-v2/ProjectionRecovery.test.ts",
      "src/orchestration-v2/ProjectionSettlement.test.ts",
      "src/orchestration-v2/ProjectionStore.test.ts",
      "src/orchestration-v2/ProviderCommitBatch.test.ts",
      "src/orchestration-v2/ProviderEventIngestor.test.ts",
      "src/orchestration-v2/ProviderSessionManager.test.ts",
      "src/orchestration-v2/RunExecutionService.test.ts",
      "src/orchestration-v2/SubagentProjection.test.ts",
      "src/orchestration-v2/ThreadLiveEventCoalescer.test.ts",
      "src/orchestration-v2/WireProjection.test.ts",
      "src/orchestration-v2/assistantStreaming.test.ts",
      "src/orchestration-v2/testkit/ProviderReplayHarness.test.ts",
    ],
  },
};
