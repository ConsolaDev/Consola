// Consola's entry (vendor/t3code/UPSTREAM.md): the reducers that apply an
// OrchestrationV2DomainEvent to an OrchestrationV2ThreadProjection, under t3's
// names. The server's (`applyToProjection`, over the full projection) is in
// `t3/orchestration-v2/ProjectionStore.ts`; the one clients apply to what the
// wire sends is `@t3tools/client-runtime`'s, vendored already.
export {
  applyToProjection,
  emptyProjection,
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
} from "t3/orchestration-v2/ProjectionStore.ts";
export {
  applyOrchestrationV2ProjectionEvent,
  getProjectionArrayReplacementIndex,
  type ApplyOrchestrationV2ProjectionEventOptions,
} from "@t3tools/client-runtime/state/orchestration-v2-projection";
