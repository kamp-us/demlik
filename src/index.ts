/**
 * @packageDocumentation
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
  DepKeyedSub,
  Dispose,
  Identity,
  Interpret,
  InterpretDetached,
  Machine,
  MachineShape,
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
  acceptedTypes,
  acceptsOf,
  applyCell,
  // The DEV-checked twin of `applyCell` (deepFreeze + assertPureResult around
  // the same cell lookup). A consumer driving its own fold — rather than `run`
  // — needs the checked step to get the purity invariants the kernel enforces
  // for itself; without it the choice is `applyCell` and no checking at all.
  applyCellChecked,
  Cmd,
  describeMachine,
  detectUpdateForm,
  foldMsgs,
  // `foldMsgs` returns state only (ADR 0006). `foldUpdates` is the fold beneath
  // it and beneath `replay`, and it returns `{ state, cmds }` — the shape a
  // caller folding a log needs when it must also act on the emitted Cmds.
  foldUpdates,
  formOf,
  msgKeysOf,
  NoCellError,
  structuralHash,
  subId,
} from "./pure/core";
export * from "./run";
export * from "./runtime-types";
