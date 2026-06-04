// ---------------------------------------------------------------------------
// Msg arbitrary builders.
//
// `MsgArbitraryTable<M>` is a strict mapped type — every Msg variant must
// have an arbitrary entry, keyed by `M["type"]`, narrowing the arbitrary's
// `T` to `Extract<M, { type: K }>`. This mirrors the load-bearing discipline
// of `Reducer<S, M, C>` and `Transitions<S, M, C>` in the substrate: adding
// a Msg variant without an arbitrary fails to compile, not at runtime.
//
// `arbMsg(table, opts?)` collapses the table into a single `fc.Arbitrary<M>`
// via `fc.oneof`. Optional per-variant weighting for sequence-skew tests.
//
// `arbConstantMsg(type)` / `arbRecordMsg(type, fields)` are sugar over
// `fc.constant({ type })` / `fc.record({ type: fc.constant(type), ...fields })`.
// They exist because every Msg variant arbitrary either (a) carries no
// payload — `arbConstantMsg("stop")` — or (b) carries a record of fields —
// `arbRecordMsg("tick", { now: fc.integer() })`. Naming the two shapes
// prevents callers from hand-rolling `fc.record({ type: fc.constant("...") })`
// inconsistently across test files.
//
// Open question 1 from the design doc (strict vs Partial table): strict by
// default. The mapped type catches drift at compile time; `arbMsgPartial`
// sugar is a future addition iff friction becomes real.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";

/**
 * Strict per-variant Msg arbitrary table. Mapped type: every key in
 * `M["type"]` MUST have an arbitrary entry whose `T` is the narrowed
 * variant. Adding a new Msg variant without an entry is a compile error
 * (same load-bearing discipline as `Reducer<S, M, C>` in the substrate).
 *
 * @example
 *   type Msg = { type: "start" } | { type: "tick"; now: number };
 *   const table: MsgArbitraryTable<Msg> = {
 *     start: arbConstantMsg("start"),
 *     tick: arbRecordMsg("tick", { now: fc.integer({ min: 0 }) }),
 *   };
 */
export type MsgArbitraryTable<M extends { type: string }> = {
  [K in M["type"]]: fc.Arbitrary<Extract<M, { type: K }>>;
};

/**
 * Build a single `fc.Arbitrary<M>` from a `MsgArbitraryTable<M>`. Picks one
 * variant per generation via `fc.oneof`; optional per-variant `weights`
 * bias the distribution (default uniform).
 *
 * @param table   Per-variant arbitrary table (strict — every variant required).
 * @param opts    Optional bias: `weights` is a `Partial<Record<M["type"], number>>`.
 *                Variants without an explicit weight default to 1.
 *
 * @example
 *   const msgArb = arbMsg<Msg>({
 *     start: arbConstantMsg("start"),
 *     tick:  arbRecordMsg("tick", { now: fc.integer() }),
 *     stop:  arbConstantMsg("stop"),
 *   }, { weights: { tick: 5, start: 1, stop: 1 } });
 */
export function arbMsg<M extends { type: string }>(
  table: MsgArbitraryTable<M>,
  opts?: { weights?: Partial<Record<M["type"], number>> },
): fc.Arbitrary<M> {
  const weights = opts?.weights;
  const entries = Object.entries(table) as [M["type"], fc.Arbitrary<M>][];
  if (entries.length === 0) {
    throw new Error("@demlik/tea/pbt: arbMsg table is empty");
  }
  const weighted = entries.map(([key, arb]) => ({
    arbitrary: arb,
    weight: weights?.[key] ?? 1,
  }));
  return fc.oneof(...weighted);
}

/**
 * Build a payload-free Msg variant arbitrary. Sugar for
 * `fc.constant({ type })` that narrows the result to `{ type: T }` literal.
 *
 * @example
 *   arbConstantMsg("stop") // fc.Arbitrary<{ type: "stop" }>
 */
export function arbConstantMsg<T extends string>(
  type: T,
): fc.Arbitrary<{ type: T }> {
  return fc.constant({ type });
}

/**
 * Build a record-shaped Msg variant arbitrary. Sugar for
 * `fc.record({ type: fc.constant(type), ...fields })` that stamps the
 * discriminator literal and combines with the per-field arbitraries.
 *
 * @example
 *   arbRecordMsg("tick", { now: fc.integer({ min: 0 }) })
 *   // fc.Arbitrary<{ type: "tick"; now: number }>
 */
export function arbRecordMsg<T extends string, R>(
  type: T,
  fields: { [K in keyof R]: fc.Arbitrary<R[K]> },
): fc.Arbitrary<{ type: T } & R> {
  // `fc.record` builds an arbitrary of the merged-shape record. The
  // `type: fc.constant(type)` field stamps the literal discriminator;
  // the spread of `fields` provides every payload field's arbitrary.
  //
  // The intermediate `as Record<string, fc.Arbitrary<unknown>>` is the
  // single load-bearing cast — fc.record's parameter type is invariant in
  // its inferred field shape, and the merged literal-and-generic spread
  // doesn't unify with the strict `{ [K in keyof R]: Arbitrary<R[K]> }`
  // shape TS computes for us. The outer cast to `fc.Arbitrary<{ type: T }
  // & R>` restates the result shape we know to be correct at this
  // boundary. Mirrors the same discipline `fc.record` callers use
  // throughout the prior-art branch.
  const recordArbitraries: Record<string, fc.Arbitrary<unknown>> = {
    type: fc.constant(type),
    ...(fields as Record<string, fc.Arbitrary<unknown>>),
  };
  return fc.record(recordArbitraries) as unknown as fc.Arbitrary<
    { type: T } & R
  >;
}
