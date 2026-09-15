/**
 * @packageDocumentation
 * @demlik/tea/timing — the call-rate batteries: coalesce a burst into one
 * fire, cap a stream to one fire per window, and gate a high-frequency input
 * into a settled, rate-capped, optionally deduped sequence of emits.
 *
 * A DOOR, not a module. Every name here is declared under
 * `src/internal/timing/` and re-exported unchanged; nothing moved and nothing
 * was renamed to open it. The modules behind it:
 *
 * - `debounce` — a timer-based call transformer that coalesces a burst of
 *   calls into a single fire.
 * - `throttle` — its sibling, capping invocation to at most once per `ms`
 *   window; the two share a symmetric surface so they read as a pair.
 * - `throttled-input` — the TEA knob over both: one config object plus
 *   pre-wired hooks you spread into your machine.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 *
 * `throttled-input` re-exports `debounce` / `throttle` (and their `Debounced`
 * / `Throttled` types) from the one declaration each already has in its own
 * module, so the repeat is one symbol seen twice, not two symbols contending
 * for a name. Nothing is dropped.
 */

export * from "../internal/timing/debounce";
export * from "../internal/timing/throttle";
export * from "../internal/timing/throttled-input";
