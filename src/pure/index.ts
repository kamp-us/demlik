/**
 * `@demlik/tea/pure` — THE client-safe entrypoint (ADR 0006, #213).
 *
 * This is the public surface for code that must NOT drag the runtime (`run`,
 * the host, `Store`, interpret, subscribe) into its bundle — the canonical
 * consumer is a client-side prediction loop. Its import graph is *provably*
 * runtime-free: every module reachable from here lives in the pure-core leaf
 * (`./core`) or the prediction leaf (`../prediction`), and NEVER reaches the
 * runtime root (`../index`). That boundary is not a tree-shaking accident — it
 * is enforced structurally by `pure/import-graph.test.ts`, which BFS-walks the
 * transitive imports and fails if `../index` ever appears.
 *
 * It re-exports two things from one client-safe path:
 *   1. the client-prediction fold seam + the pure type vocabulary (from
 *      pure-core), and
 *   2. the client-prediction ack primitive (from `../prediction`).
 *
 * `@demlik/tea/prediction` remains the focused standalone leaf; this module
 * cross-references it so a prediction loop imports the fold seam AND the ack
 * from a single client-safe entry (ADR 0006 coherence note).
 */

export type { Ack, AckPartition, Seq, SeqTagged } from "../prediction";
// The client-prediction ack primitive + the reconciliation helper —
// cross-referenced here so a prediction loop imports the fold seam, the ack, AND
// the reconcile step from one client-safe path (ADR 0006 coherence note).
// `@demlik/tea/prediction` remains the focused standalone leaf.
export {
  ack,
  initAck,
  NO_ACK,
  nextSeq,
  partitionByAck,
  reconcile,
  tagSeq,
} from "../prediction";
export type {
  ContextFree,
  Interpret,
  Machine,
  NoCtx,
  Port,
  PortEmitter,
  Reducer,
  Sub,
  SubId,
  Subscribe,
  SyncReturn,
  Transitions,
  UpdateForm,
} from "./core";
// The client-prediction fold seam + the pure type vocabulary (ADR 0006).
export { Cmd, detectUpdateForm, foldMsgs, formOf, subId } from "./core";
