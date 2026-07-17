/**
 * @demlik/tea/debounce — a timer-based call transformer that coalesces a burst
 * of calls into a single fire.
 *
 * Sibling of `@demlik/tea/throttle` — the two share a SYMMETRIC surface
 * (`Debounced<A>` / `Throttled<A>`, both callable + `.cancel()` + `.flush()`,
 * both `{ leading?, trailing? }`) so they read as a pair. They are kept in
 * separate files with NO cross-import: each is a self-contained timer, and the
 * coalesce-vs-drop policies are different enough that sharing code would hide
 * the distinction. Read one to understand the other; do not couple them.
 *
 * Layering with `@demlik/tea/throttled-input`: `debounce` and `throttle` are
 * the two host-boundary PRIMITIVES — two distinct algorithms (collapse-a-burst
 * vs at-most-once-per-window) behind one signature shape. `throttled-input` is
 * NOT a third primitive: it is a TEA machine composed OVER them that
 * re-exports both (see its module doc for the full layering map).
 *
 * WHAT THIS IS NOT — and why it lives outside `update`:
 *
 *   - NOT a reducer / Transitions cell. Reducers are PURE (invariant 2 — same
 *     inputs → same outputs, no `Date.now`, no timers). A debounce holds a live
 *     `setTimeout` handle and mutable pending-args state; folding it into
 *     `update` would smuggle a timer into the pure core.
 *   - NOT a Sub. A Sub is a continuous SOURCE of Msgs the substrate reconciles
 *     by id every transition (invariant 4). A debounce is a SINK transformer:
 *     it wraps a `void`-returning handler (the canonical one is
 *     `Runtime.dispatch`) so bursty HOST events coalesce BEFORE they ever
 *     become a Msg.
 *
 * It is a higher-order function at the host boundary (pattern 14 — TEA owns
 * state, JS owns timing). The host attaches the wrapped function to a noisy
 * event source (`scroll`, `resize`, `input`, a ResizeObserver) and the
 * substrate downstream only ever sees the coalesced Msg:
 *
 *   const onResized = debounce(
 *     () => runtime.dispatch({ type: "BrowserResizedWindow" }),
 *     150,
 *   );
 *   window.addEventListener("resize", onResized);
 *   // cleanup: onResized.cancel(); window.removeEventListener("resize", onResized);
 *
 * NOT exported from the package root — reached via the `@demlik/tea/debounce`
 * subpath, same one-shape-per-package rule as `rate-limit`, `deadline`, and
 * `work-queue`.
 *
 * Uses the universal `setTimeout` / `clearTimeout` timer idiom (same discipline
 * as `subs/from-timeout.ts`): exactly one live handle at a time, every arm
 * clears the previous, every fire / cancel clears the handle and nulls it so a
 * stale callback can never run.
 */

/**
 * A debounced wrapper around `fn`. Callable with the SAME argument tuple as
 * `fn` — `(...args: A) => void` — plus two control methods that share names and
 * shapes with `Throttled<A>` so the two modules read as a symmetric pair.
 */
export interface Debounced<A extends readonly unknown[]> {
  /** Schedule (or re-schedule) a fire of the wrapped `fn`. See `debounce`. */
  (...args: A): void;
  /**
   * Drop any pending trailing fire WITHOUT invoking `fn`. Clears the timer and
   * forgets the captured args. Idempotent — calling it with nothing pending is
   * a no-op. The leading-edge latch (if `leading` is enabled) also resets, so
   * the next call after `cancel` is treated as a fresh burst.
   *
   * The host-cleanup partner of `removeEventListener`: cancel the pending fire
   * when the component unmounts / the listener detaches, so a queued
   * `dispatch` can't land after teardown.
   */
  cancel(): void;
  /**
   * Fire any pending trailing call IMMEDIATELY with its captured args, then
   * clear the timer. No-op when nothing is pending. Use to force the last
   * coalesced call out early — e.g. flush a debounced save on `beforeunload`,
   * or flush a debounced search when the user presses Enter.
   */
  flush(): void;
}

/**
 * Wrap `fn` so a BURST of calls collapses to a single invocation.
 *
 * Trailing edge (the default): each call (re)starts a `ms` timer; `fn` fires
 * once with the LAST args after `ms` of quiet. Every call within `ms` of the
 * previous resets the timer — the classic "wait until the user stops typing"
 * behavior.
 *
 * @param fn   The handler to coalesce. Typically `(...) => runtime.dispatch(...)`,
 *             but any `(...args: A) => void` works. The return value is
 *             ignored — debounce is a fire transformer, not a value pipe.
 * @param ms   Quiet window in milliseconds. Calls closer together than `ms`
 *             coalesce; a gap of at least `ms` lets the trailing fire through.
 * @param opts.leading   Fire on the FIRST call of a burst (the leading edge),
 *             with that first call's args. Default `false`.
 * @param opts.trailing  Fire on the trailing edge with the LAST call's args.
 *             Default `true`.
 *
 * Edge combinations (matching lodash's settled semantics, the de-facto
 * standard the ecosystem rediscovered):
 *
 *   - `{ trailing: true }` (default): one fire, after the burst, last args.
 *   - `{ leading: true, trailing: false }`: one fire, at the burst START,
 *     first args. Subsequent calls within the window are swallowed; the timer
 *     only re-opens the "can lead again" latch after `ms` of quiet.
 *   - `{ leading: true, trailing: true }`: fires at the start AND end of a
 *     burst — BUT the trailing fire is SUPPRESSED for a burst of exactly ONE
 *     call (the leading fire already covered it, so a lone call doesn't
 *     double-fire). This matches lodash and is the behavior tests pin.
 *   - `{ leading: false, trailing: false }`: never fires. Degenerate but legal;
 *     we don't throw — the caller asked for a no-op transformer.
 *
 * WHY a default of trailing-only: a debounce's whole job is "act after the
 * activity settles." The trailing edge IS that semantic — fire with the final
 * state of the burst (the last keystroke, the final scroll position). Leading
 * is the opt-in for "respond instantly, then go quiet."
 */
export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  opts?: { leading?: boolean; trailing?: boolean },
): Debounced<A> {
  const leading = opts?.leading ?? false;
  const trailing = opts?.trailing ?? true;

  // Exactly one live handle at a time (the from-timeout discipline). `null`
  // when no fire is pending — the single source of truth for "is a timer
  // armed?". Every arm clears the previous handle before opening a new one, so
  // we never leak overlapping timers across a burst.
  let handle: ReturnType<typeof setTimeout> | null = null;
  // The most recent args, held only while a trailing fire is pending. Captured
  // on every call (the trailing edge fires with the LAST args), cleared the
  // instant we fire / cancel so a stale tuple can never leak into a later
  // burst. `null` (not `undefined`) is the empty sentinel because `A` may
  // itself contain `undefined` elements — a present-but-empty tuple is still a
  // pending call, distinct from "nothing pending".
  let pendingArgs: A | null = null;
  // Leading-edge latch: true once a leading fire has happened for the current
  // burst, reset to false after `ms` of quiet (the timer's expiry) or on
  // `cancel`. Gates the "fire on first call of a burst, then stay quiet" rule
  // so mid-burst calls don't re-trigger the leading fire.
  let leadingFired = false;

  function clearHandle(): void {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  }

  // Timer expiry: the burst has gone quiet for `ms`. Fire the trailing edge if
  // one is owed, then reset all burst state so the NEXT call starts a fresh
  // burst (re-arming the leading latch, clearing pending args).
  function onTimerExpired(): void {
    handle = null;
    // Suppress the trailing fire for a lone leading-only-eligible call:
    // when `leadingFired` is true AND trailing is enabled, a burst of exactly
    // one call already fired on the leading edge — `pendingArgs` was cleared
    // at that point, so there is nothing to fire here. A burst of 2+ calls
    // re-captured `pendingArgs` after the leading fire, so the trailing fire
    // lands with the last args. The `pendingArgs !== null` guard encodes
    // exactly that distinction; no separate call-count needed.
    if (trailing && pendingArgs !== null) {
      const args = pendingArgs;
      pendingArgs = null;
      fn(...args);
    }
    // Burst over — re-open the leading latch for the next burst.
    leadingFired = false;
  }

  const debounced = (...args: A): void => {
    // Leading edge: the FIRST call of a burst (no timer armed yet, latch open).
    // Fire immediately with this call's args; do NOT stash them as pending so a
    // lone call won't also fire on the trailing edge.
    const isBurstStart = handle === null;
    if (leading && isBurstStart && !leadingFired) {
      leadingFired = true;
      fn(...args);
    } else if (trailing) {
      // Capture the latest args for the trailing fire. Overwrites any prior
      // pending tuple — the trailing edge fires with the LAST args, by design.
      pendingArgs = args;
    }

    // (Re)arm the quiet-window timer. Clearing the previous handle is what
    // makes the window SLIDE: every call within `ms` pushes the trailing fire
    // out to `ms` after THIS call.
    clearHandle();
    handle = setTimeout(onTimerExpired, ms);
  };

  debounced.cancel = (): void => {
    clearHandle();
    pendingArgs = null;
    leadingFired = false;
  };

  debounced.flush = (): void => {
    // Force the pending trailing fire out now. Mirrors `onTimerExpired`'s fire
    // branch but is caller-driven rather than timer-driven, so it also tears
    // down the armed timer (a timer-driven expiry already nulled `handle`).
    if (pendingArgs !== null) {
      const args = pendingArgs;
      pendingArgs = null;
      clearHandle();
      // A flushed trailing fire ends the burst, same as a natural expiry.
      leadingFired = false;
      fn(...args);
    } else {
      // Nothing pending — still tear down a lingering leading-only timer so a
      // post-flush call leads cleanly.
      clearHandle();
      leadingFired = false;
    }
  };

  return debounced;
}
