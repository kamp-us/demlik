// ===========================================================================
// Protocol — the ONE typed source of truth for the cross-module Msg/Cmd
// discriminant strings (issue #60).
// ===========================================================================
//
// The resilient/agent/auth plumbing speaks a small fixed vocabulary of
// discriminant strings on `{ type: ... }` Msgs and Cmds. Before this module
// those literals were retyped inline across ~8 modules — `resilient_ok` alone
// appeared as a hand-written `"resilient_ok"` in resilient-call, with-resilience,
// llm-call, agent, do/host, paginated-walk, reconciler. Adding a variant or
// renaming one was shotgun surgery with no compiler to catch a missed site.
//
// `MsgType` is that vocabulary, declared ONCE `as const`. Each entry is BOTH:
//   - a value — `MsgType.ResilientOk` is the string `"resilient_ok"`, used at
//     construction sites (`{ type: MsgType.ResilientOk, ... }`), reducer keys
//     (`[MsgType.ResilientOk]: ...`), and switch labels (`case MsgType.ResilientOk:`).
//   - a type — `typeof MsgType.ResilientOk` is the literal type `"resilient_ok"`,
//     used in the `readonly type:` field of every Msg/Cmd interface.
//
// Because the value and the type both derive from the single `as const`
// declaration, a new variant or a rename is a ONE-LINE change here that
// propagates with full exhaustiveness — not an 8-file edit.
//
// This module is BEHAVIOR-PRESERVING: every string is byte-identical to the
// literal it replaces. It is internal plumbing vocabulary, NOT a public event
// surface — `resilient_ok` / `agent_tool_ok` stay PRIVATE (the agent's
// `agentEvents` projector is the ONE place they are read; #47). Centralizing
// the literal here does NOT re-expose them to consumers.

/**
 * The closed set of cross-module Msg/Cmd discriminant strings. Declared `as
 * const` so each entry is usable as both a value (construction / reducer keys /
 * switch labels) and, via `typeof MsgType.X`, a literal type (`readonly type:`
 * fields). The single source of truth for issue #60.
 */
export const MsgType = {
  // --- resilient-call: the run Cmd + its two settle Msgs -------------------
  /** The "run the port for `key`" effect Cmd resilient-call emits. */
  ResilientRun: "resilient_run",
  /** PRIVATE success settle Msg (read only by `agentEvents`, #47). */
  ResilientOk: "resilient_ok",
  /** Failure settle Msg — routed to the `fail` verb (back off via retry). */
  ResilientErr: "resilient_err",

  // --- agent: the wired machine's own entry-point Msgs ---------------------
  /** Begin a run. */
  AgentStart: "agent_start",
  /** PRIVATE tool-fan-out success settle Msg (read only by `agentEvents`, #47). */
  AgentToolOk: "agent_tool_ok",
  /** Tool-fan-out failure settle Msg. */
  AgentToolErr: "agent_tool_err",
  /**
   * Re-fire the one outstanding effect on rehydrate (the do↔agent seam). Fired
   * by `do/host`'s `autoBoot` via the typed `agentBootMsg` constructor, matched
   * by the agent reducer — see `AgentBootPort` in `../agent`.
   */
  AgentBoot: "agent_boot",

  // --- agent: the context-compaction round-trip (#85) ----------------------
  /**
   * The "summarize the oldest N turns" effect Cmd the agent emits when its
   * `CompactionPolicy` asks to compact before a brain call. A DEDICATED
   * round-trip (design B1), distinct from the brain call's `resilient_run`, so
   * compaction is its own honest `Awaiting` state — see `../agent`.
   */
  CompactRun: "compact_run",
  /** Compaction round-trip resolved — carries the summary text the fold-back folds. */
  CompactOk: "compact_ok",
  /** Compaction round-trip failed (exhausted retry) — surfaced as data, not a stall. */
  CompactErr: "compact_err",

  // --- token-refresh: the two refresh-result Msgs --------------------------
  /** Refresh port resolved — carries the fresh `Token`. */
  TokenRefreshed: "token_refreshed",
  /** Refresh port rejected — carries the rejection (errors are data). */
  TokenRefreshFailed: "token_refresh_failed",

  // --- authed-call: the 401 trigger ----------------------------------------
  /** The 401 the consumer dispatches when a guarded call comes back unauthorized. */
  Unauthorized: "unauthorized",
} as const;

/** The union of every discriminant string in the protocol. */
export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];
