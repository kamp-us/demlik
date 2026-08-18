// ═══════════════════════════════════════════════════════════════════════════
// THE LIVE LAYER — the chart, asked about the state it is in RIGHT NOW.
//
// The static description says what the machine can do anywhere. This says what
// it can do here: which events are legal, which are refused and why, and — the
// genuinely new capability — WHICH BRANCH a guarded edge would take, evaluated
// by running the named guard against the live state and a sample msg.
//
// Everything here is PURE. Guards, cells and cmd builders are pure by the TEA
// invariants (they are the same things `replay` is allowed to call), so a
// preview costs nothing and changes nothing. Nothing in this file dispatches,
// interprets, or touches a runtime.
//
// HONEST DEGRADATION is the design rule. A guard that cannot be evaluated — no
// sample for its msg, no `guards` bag, a body that throws on this state — is
// reported as `unknown` WITH the reason. It is never guessed, and never
// silently rendered as `else`.
// ═══════════════════════════════════════════════════════════════════════════

import type { EventOrigin } from "../graph";
import {
  type ChartDescription,
  type ChartEdge,
  edgeAt,
  explainRefusal,
  type RefusalReason,
  refusalAtState,
} from "./describe";
import { type RtSamples, sampleMsg } from "./samples";

// ── the runtime views of the parts bag ────────────────────────────────────
type RtState = { readonly type: string; readonly was?: string };
type RtMsg = { readonly type: string };
type RtGuard = (s: RtState, m: RtMsg, at: string) => boolean;
type RtCellFn = (
  s: RtState,
  m: RtMsg,
  at: string,
) => readonly [RtState, readonly { readonly type: string }[]];

// The parameter type is `never[]`, deliberately. A `Guards<C, S, M>` entry is
// PRE-NARROWED to its use site (`(s: ReviewState, m: FailMsg, at: "review.FAIL")`),
// and parameters are checked contravariantly — so a bag typed against a widened
// `(s: { type: string }, …)` REJECTS the very bag `compile` demands, which would
// force every caller to cast the parts they already have. `never` is the one
// parameter type every function accepts, so the author passes `parts` through
// untouched; the narrowing back to a callable shape is one cast, here, at the
// call boundary (the same place `compile` puts its own).
/** Any guard, however narrowly its use sites typed it. */
export type AnyGuard = (...args: never[]) => boolean;
/** Any cell, in either the single-body or the per-site form. */
export type AnyCell =
  | ((...args: never[]) => readonly [{ readonly type: string }, unknown])
  | Readonly<Record<string, unknown>>;

/**
 * The code parts a preview may consult — the SAME bag `compile` receives, so
 * an author passes the one they already built rather than a second copy.
 * Every field is optional: the preview degrades where a part is absent.
 */
export interface InspectParts {
  readonly guards?: Readonly<Record<string, AnyGuard | undefined>>;
  readonly cells?: Readonly<Record<string, AnyCell | undefined>>;
}

/** Everything a live preview may consult, beyond the state itself. */
export interface InspectOptions {
  /** The parts bag `compile` was given. Guards/cells are read from it. */
  readonly parts?: InspectParts;
  /** Sample payload per event — see `./samples`. */
  readonly samples?: RtSamples;
}

// ── guard preview ─────────────────────────────────────────────────────────

/** Why a guard could not be evaluated. Each is a fact, not a guess. */
export type GuardUnknown =
  | "no-guard-bag"
  | "no-implementation"
  | "no-sample"
  | "threw";

/**
 * Which branch a guarded edge would take right now.
 *
 * `then` / `else` are ANSWERS — the guard ran, on this state, with this msg.
 * `unknown` is the honest non-answer, carrying the reason and (for a throwing
 * guard) the message, so a UI shows "cannot evaluate: no sample for FAIL"
 * rather than a confidently wrong arrow.
 */
export type GuardPreview =
  | {
      readonly guard: string;
      readonly branch: "then" | "else";
      /** The state that branch lands on. */
      readonly target: string;
      /** The cmds that branch fires. */
      readonly cmds: readonly string[];
    }
  | {
      readonly guard: string;
      readonly branch: "unknown";
      readonly why: GuardUnknown;
      /** The thrown error's message, when `why` is `"threw"`. */
      readonly error?: string;
    };

/** Run the named guard against `state` + a sample msg. Never throws. */
function previewGuard(
  edge: ChartEdge,
  state: RtState,
  msg: RtMsg | undefined,
  opts: InspectOptions,
): GuardPreview {
  const guard = edge.guard as string;
  const bag = opts.parts?.guards;
  if (bag === undefined)
    return { guard, branch: "unknown", why: "no-guard-bag" };
  const fn = bag[guard] as RtGuard | undefined;
  if (fn === undefined)
    return { guard, branch: "unknown", why: "no-implementation" };
  if (msg === undefined) return { guard, branch: "unknown", why: "no-sample" };
  try {
    const held = fn(state, msg, edge.at) === true;
    return held
      ? {
          guard,
          branch: "then",
          target: edge.then ?? "",
          cmds: edge.cmds,
        }
      : {
          guard,
          branch: "else",
          target: edge.otherwise ?? "",
          cmds: edge.otherwiseCmds,
        };
  } catch (e) {
    return {
      guard,
      branch: "unknown",
      why: "threw",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── target resolution ─────────────────────────────────────────────────────

/** How a single target was determined, when one could be. */
export type ResolvedBy = "declared" | "guard" | "resume" | "cell";

/** Run a cell purely to learn which target it actually picks. Never throws. */
function runCell(
  edge: ChartEdge,
  state: RtState,
  msg: RtMsg | undefined,
  opts: InspectOptions,
): string | undefined {
  const impl = opts.parts?.cells?.[edge.cell as string] as
    | RtCellFn
    | Record<string, RtCellFn | undefined>
    | undefined;
  if (impl === undefined || msg === undefined) return undefined;
  // The two cell forms `compile` supports: one body for every site, or one
  // body per site keyed by `at`.
  const hand = typeof impl === "function" ? impl : impl[edge.at];
  if (hand === undefined) return undefined;
  try {
    const [next] = hand(state, msg, edge.at);
    const to = next?.type;
    // Respect the edge's own `to` clamp: a cell that returns outside it is the
    // `CellTargetError` case, and a preview must not draw what the runtime
    // would refuse.
    return typeof to === "string" && edge.targets.includes(to) ? to : undefined;
  } catch {
    return undefined;
  }
}

// ── the verdict ───────────────────────────────────────────────────────────

/**
 * What would happen if `event` were dispatched at the current state.
 *
 * A refusal is FIRST-CLASS: it carries the reason and a rendered explanation,
 * so a UI draws it as visibly refused rather than omitting the control. That
 * is the totality property paying rent — the chart knows the difference
 * between "not routed here", "deliberately dropped here" and "this state is
 * over", and a debugger that hides all three behind a missing button throws
 * away the one thing this substrate knows and others do not.
 */
export interface EventPreview {
  readonly event: string;
  readonly status: "legal" | "refused";
  /**
   * Who would send this — the event's declared `from`, carried through rather
   * than recomputed, so a button row can be grouped by sender with the same
   * answer the report's "waiting on" line gives. `undefined` when the chart
   * does not say.
   */
  readonly from?: EventOrigin;
  /** Present iff `status` is `"refused"`. */
  readonly reason?: RefusalReason;
  /** A one-line rendering of `reason`. Present iff refused. */
  readonly why?: string;
  /** The declared edge. Present iff legal. */
  readonly edge?: ChartEdge;
  /** Present iff the edge is guarded. */
  readonly guard?: GuardPreview;
  /**
   * The cmds that would fire. For a guarded edge whose branch resolved, the
   * cmds of THAT arm; for one that did not, the `then` arm's (the declared
   * happy path) — `guard.branch === "unknown"` is what says so.
   */
  readonly cmds: readonly string[];
  /** Every state the edge declares it can reach. */
  readonly targets: readonly string[];
  /** The single target, when one is determined. */
  readonly resolved?: string;
  /** How {@link EventPreview.resolved} was determined. */
  readonly resolvedBy?: ResolvedBy;
  /**
   * The msg this preview used — the sample plus the chart's `type`. `undefined`
   * when the event declares a payload and no sample was supplied, which is
   * also why a guard or cell may have come back `unknown`.
   */
  readonly msg?: { readonly type: string };
}

/**
 * Preview one event against a live state.
 *
 * @param desc  the chart's {@link ChartDescription}.
 * @param state the live state — anything with a `type` (and `was`, on a
 *              parking state, which is what makes a resume target resolvable).
 */
export function previewEvent<S extends { readonly type: string }>(
  desc: ChartDescription,
  state: S,
  event: string,
  opts: InspectOptions = {},
): EventPreview {
  const st = state as RtState;
  const edge = edgeAt(desc, st.type, event);
  const info = desc.events.find((e) => e.name === event);
  // The ONE read of provenance in this file, shared by both arms: a refused
  // event has a sender too, and hiding it would make the refused half of a
  // grouped button row unfilable.
  const from = info?.from === undefined ? {} : { from: info.from };

  if (edge === undefined) {
    const reason = refusalAtState(desc, st.type, event) ?? {
      kind: "undeclared" as const,
    };
    return {
      event,
      ...from,
      status: "refused",
      reason,
      why: explainRefusal(event, reason),
      cmds: [],
      targets: [],
    };
  }

  const msg = sampleMsg(event, info?.hasPayload === true, opts.samples);
  const base = {
    event,
    ...from,
    status: "legal" as const,
    edge,
    targets: edge.targets,
    msg,
  };

  switch (edge.kind) {
    case "plain":
      return {
        ...base,
        cmds: edge.cmds,
        resolved: edge.targets[0],
        resolvedBy: edge.targets.length === 1 ? "declared" : undefined,
      };

    case "guarded": {
      const guard = previewGuard(edge, st, msg, opts);
      return {
        ...base,
        guard,
        cmds: guard.branch === "unknown" ? edge.cmds : guard.cmds,
        resolved: guard.branch === "unknown" ? undefined : guard.target,
        resolvedBy: guard.branch === "unknown" ? undefined : "guard",
      };
    }

    case "resume":
      // `was ?? fallback` — the runtime's own rule, read off the live state.
      // This is always resolvable, because `was` is INJECTED by the compiler
      // on entry to a parking state rather than authored.
      return {
        ...base,
        cmds: edge.cmds,
        targets: st.was === undefined ? edge.targets : [st.was],
        resolved: st.was ?? edge.fallback,
        resolvedBy: "resume",
      };

    case "cell": {
      const resolved = runCell(edge, st, msg, opts);
      return {
        ...base,
        // A cell builds its own cmds inside its body, so the chart declares
        // none for it — `cmds` is empty by declaration, not by omission.
        cmds: edge.cmds,
        resolved,
        resolvedBy: resolved === undefined ? undefined : "cell",
      };
    }
  }
}

/**
 * Preview EVERY event of the alphabet against a live state, in the chart's
 * declaration order.
 *
 * This is the button row: one entry per declared event, each either legal
 * (with its branch, targets and cmds) or refused (with its reason). Nothing is
 * filtered out — a refused event is a control the UI draws, not one it lacks.
 */
export function inspectState<S extends { readonly type: string }>(
  desc: ChartDescription,
  state: S,
  opts: InspectOptions = {},
): readonly EventPreview[] {
  return desc.events.map((e) => previewEvent(desc, state, e.name, opts));
}

/**
 * {@link inspectState}, plus the two roll-ups a caller almost always wants
 * next: the legal event names and the refused ones.
 *
 * The whole verdict list is still there — the split is a convenience, not a
 * filter, and `events` remains the surface a UI renders so a refusal keeps its
 * reason.
 */
export function inspectStateSummary<S extends { readonly type: string }>(
  desc: ChartDescription,
  state: S,
  opts: InspectOptions = {},
): {
  readonly state: S;
  readonly events: readonly EventPreview[];
  readonly legal: readonly string[];
  readonly refused: readonly string[];
} {
  const events = inspectState(desc, state, opts);
  return {
    state,
    events,
    legal: events.filter((e) => e.status === "legal").map((e) => e.event),
    refused: events.filter((e) => e.status === "refused").map((e) => e.event),
  };
}
