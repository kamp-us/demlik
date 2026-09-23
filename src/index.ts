/**
 * @packageDocumentation
 * @demlik/tea — TEA-faithful state machine substrate.
 *
 * Root barrel — the neutral core. It carries `defineMachine`, `Cmd`, `replay`
 * and the pure types, and it imports no engine: `run` lives on
 * `@demlik/tea/promise`, and the Effect engine on `@demlik/tea/effect`.
 * `src/entry-points.import-graph.test.ts` fails the build if that changes.
 */

// The composition seam — `liftSlice` / `readInOrder`, the layer between a
// battery and a door. It lands on the ROOT door rather than a battery subpath
// because both `./resilience` and `./jev` import it, so it cannot live inside
// either one.
export * from "./compose";
export * from "./observability";
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
  ExhaustiveTransitions,
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
  // `acceptedTypes` answers about the state VALUE a caller holds, where
  // `acceptsOf` answers about a `state.type` a tool already named. It is the
  // same reading a refusal carries — `lookupCell`'s miss arm calls it — so
  // asking first and dispatching-and-catching can never disagree.
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
export * from "./runtime-types";
export * from "./subs";
