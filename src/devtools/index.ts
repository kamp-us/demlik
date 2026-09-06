/**
 * @packageDocumentation
 * @demlik/tea/devtools — presentational inspector for any tea machine.
 *
 * Three pieces, fully decoupled from the runtime:
 *
 *   - <StateInspector state flashKey?> — JSON state viewer that flashes when
 *     the supplied key changes. Pure, no subscription.
 *   - useMsgHistory(dispatch, max?) — wraps a dispatch and records every Msg
 *     it sees. Returns [history, wrappedDispatch].
 *   - <MsgLog history /> — presentational list view over the history.
 *
 * The deliberate constraint: this package does NOT take a Runtime. State and
 * history are props. That keeps it usable from `useMachine`, from an
 * externally-built runtime, or from a test harness — your code owns the wiring.
 *
 * The state-diff trio (`diffState` / `formatDiff` are pure + zero-dep, usable
 * in Node and tests; `<StateDiff>` is the React view) is the richer cousin of
 * `../internal/persistence/trace-replay`'s first-divergence walk — same path
 * grammar, but EVERY differing cell, classified as added / removed / changed.
 *
 * `toMermaid` (with `safeId` / `safeLabel` and `MachineVizOptions`) draws a
 * `Machine` as a Mermaid state diagram. It was `@demlik/tea/machine-viz` until
 * #49 folded that door into this one; the function is unchanged, pure and
 * React-free — only its import path moved.
 */

export {
  type MachineVizOptions,
  safeId,
  safeLabel,
  toMermaid,
} from "./machine-viz";
export { MsgLog, type MsgLogEntry, type MsgLogProps } from "./msg-log";
export { diffState, formatDiff, type StateChange } from "./state-diff";
export { StateDiff, type StateDiffProps } from "./state-diff-view";
export { StateInspector, type StateInspectorProps } from "./state-inspector";
export { useMsgHistory } from "./use-msg-history";
