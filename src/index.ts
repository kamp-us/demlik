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
// The host-side provider graph — `provide` / `layer` / `value` — lands on the
// ROOT door beside `run`, not on a subpath of its own. It has no host-specific
// half: `/node`, `/do` and `/mem` are `Store` adapters, and this satisfies a
// Cmd's `R` at `run`'s `ctx` seam, which every one of them shares.
export * from "./provide";
// `./pure` and `./subs` are no longer doors of their own (#51): the closing
// sweep pinned the export map to the public doors, and ADR 0016 moves parts
// rather than dropping them — so the whole runtime-free surface and the whole
// subscription-factory surface land here, on the root door, as named exports.
// The runtime-free GUARANTEE still lives in `src/pure/`, which nothing outside
// it may import from; the door it used to have is what closed.
export * from "./pure";
export type {
  AnyCmdDef,
  CmdDef,
  CmdInput,
  CmdOf,
  CmdValue,
  DepKeyedSub,
  Dispose,
  ErrOf,
  ErrorsOf,
  Identity,
  Interpret,
  InterpretDetached,
  Machine,
  MachineShape,
  MalformedResult,
  NoCtx,
  OkOf,
  Port,
  PortEmitter,
  Reducer,
  RequiredCtx,
  Requirements,
  RequirementsOf,
  Settled,
  SettledErr,
  SettledOk,
  Sub,
  SubId,
  Subscribe,
  SyncReturn,
  Tagged,
  TaggedError,
  Transitions,
  UpdateForm,
} from "./pure/core";
// Re-export the pure-core surface so the root `@demlik/tea` entry is unchanged
// (additive; the runtime-free guarantee lives in `src/pure/`).
export {
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
export * from "./subs";
