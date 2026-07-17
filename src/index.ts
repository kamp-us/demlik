/**
 * @demlik/tea — TEA-faithful state machine substrate.
 *
 * Root barrel. The runtime surface is split across three concern modules —
 * `./runtime-types` (the interface surface + the pure construction/composition
 * helpers: `defineMachine`, `asReducer`, `replay`, `tryInterpret`), `./run`
 * (`run` + boot + the serial dispatch loop), and `./observability`
 * (`historyTracker`) — and re-exported here so the public `@demlik/tea` entry is
 * unchanged.
 */

export * from "./observability";
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
} from "./pure/core";
// Re-export the pure-core surface so the root `@demlik/tea` entry is unchanged
// (additive; the runtime-free guarantee lives on `@demlik/tea/pure`).
export {
  applyCell,
  Cmd,
  detectUpdateForm,
  foldMsgs,
  formOf,
  msgKeysOf,
  NoCellError,
  subId,
} from "./pure/core";
export * from "./run";
export * from "./runtime-types";
