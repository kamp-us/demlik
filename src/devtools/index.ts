/**
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
 * `../trace-replay`'s first-divergence walk — same path grammar, but EVERY
 * differing cell, classified as added / removed / changed.
 */

export { MsgLog, type MsgLogEntry, type MsgLogProps } from "./msg-log";
export { diffState, formatDiff, type StateChange } from "./state-diff";
export { StateDiff, type StateDiffProps } from "./state-diff-view";
export { StateInspector, type StateInspectorProps } from "./state-inspector";
export { useMsgHistory } from "./use-msg-history";
