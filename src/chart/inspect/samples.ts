// ═══════════════════════════════════════════════════════════════════════════
// SAMPLES — the one thing the chart genuinely cannot know, typed BY the chart.
//
// `ty<T>()` is `{}` at runtime (graph.ts:33): a phantom whose TYPE remembers
// the payload and whose VALUE remembers nothing. So an inspector that wants to
// dispatch `WIP` cannot invent `{ at: 1 }` — the shape is erased before any
// runtime code could read it.
//
// The author therefore supplies a sample per event. That is a REAL fact the
// chart does not carry (what a plausible `at` is), which is why it is a prop
// at all — and it is the ONLY payload prop, because everything else about the
// event (its name, its scope, whether it carries a payload) IS in the chart.
//
// The bag is typed the same way `Assigns`/`Guards`/`Cmds` are: a mapped type
// over a key union DERIVED from the chart, so the sample for `X` must be
// exactly `X`'s declared payload, a typo'd event name is an excess property,
// and an event whose payload the author forgot is a missing property tsc names.
// ═══════════════════════════════════════════════════════════════════════════

import type { EventName, MsgOf } from "../graph";

type Narrow<U, K> = Extract<U, { type: K }>;

/**
 * Event `E`'s declared payload — its Msg member minus the `type` the chart
 * already owns.
 *
 * Read off `MsgOf<C>` rather than off the `events` section directly, so it is
 * the SAME derivation the compiled machine consumes: a sample that type-checks
 * here is a msg the machine accepts, by construction. An event with no `data`
 * has `DataOf = unknown`, so this is `{}` — no keys, nothing to supply.
 */
export type SamplePayload<C, E extends string> = Omit<
  Narrow<MsgOf<C>, E>,
  "type"
>;

/** Does event `E` declare a payload the author must fill in? */
type NeedsSample<C, E extends string> = [keyof SamplePayload<C, E>] extends [
  never,
]
  ? false
  : true;

/**
 * The sample bag: one entry per event that DECLARES a payload, each typed as
 * exactly that payload.
 *
 * The `as` clause drops the payload-free events from the key union entirely —
 * so `{ START: {} }` for a bare `START: { scope: "edges" }` is an excess
 * property tsc rejects, rather than a meaningless entry it accepts. "Where an
 * event has no declared payload, no sample is required" is therefore not a
 * convention; it is unrepresentable to supply one.
 *
 * The `type` tag is absent for the same reason it is absent from an `assign`'s
 * return: it is the chart's fact, stamped on by {@link sampleMsg}, so the
 * author cannot write it wrong and cannot write it twice.
 *
 * ```ts
 * const samples: Samples<LaneG> = {
 *   WIP: { at: 1 },
 *   FAIL: { at: 2, reason: "flaky" },   // `reason` is REQUIRED — the chart says so
 *   // BLOCKED: …                        // omit one and tsc names it
 * };
 * ```
 */
export type Samples<C> = {
  readonly [E in EventName<C> as [NeedsSample<C, E>] extends [true]
    ? E
    : never]: SamplePayload<C, E>;
};

/** The samples bag as the runtime reads it: event name → payload object. */
export type RtSamples = Readonly<Record<string, object | undefined>>;

/**
 * Build the Msg for `event` from the sample bag: the payload, plus the `type`
 * the chart owns.
 *
 * Returns `undefined` exactly when the event needs a payload and none was
 * supplied — which is the honest "cannot" the guard preview degrades on,
 * rather than a half-built msg that makes a guard throw for the wrong reason.
 */
export function sampleMsg(
  event: string,
  hasPayload: boolean,
  samples: RtSamples | undefined,
): { readonly type: string } | undefined {
  const payload = samples?.[event];
  if (payload === undefined) {
    return hasPayload ? undefined : { type: event };
  }
  return { ...payload, type: event };
}
