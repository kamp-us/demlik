/**
 * @demlik/tea/throttle — a timer-based call transformer that caps invocation
 * to at most once per `ms` window.
 *
 * Sibling of `@demlik/tea/debounce` — the two share a SYMMETRIC surface
 * (`Throttled<A>` / `Debounced<A>`, both callable + `.cancel()` + `.flush()`,
 * both `{ leading?, trailing? }`) so they read as a pair. They are kept in
 * separate files with NO cross-import: each is a self-contained timer, and the
 * coalesce-vs-drop policies differ enough that sharing code would hide the
 * distinction. The contrast IS the lesson:
 *
 *   - **debounce** waits for quiet — fires once AFTER a burst settles.
 *   - **throttle** enforces a rate — fires AT MOST once per `ms` while the
 *     burst is ongoing, dropping the calls in between.
 *
 * Layering with `@demlik/tea/throttled-input`: `throttle` and `debounce` are
 * the two host-boundary PRIMITIVES — two distinct algorithms
 * (at-most-once-per-window vs collapse-a-burst) behind one signature shape.
 * `throttled-input` is NOT a third primitive: it is a TEA machine composed
 * OVER them (the same semantics, reimplemented as pure, durable Model state)
 * that re-exports both. Wrapping a raw host event → these primitives; durable, replayable
 * gating inside a machine → `throttled-input` (see its module doc for the full
 * layering map).
 *
 * WHAT THIS IS NOT — and why it lives outside `update`:
 *
 *   - NOT a reducer / Transitions cell. Reducers are PURE (invariant 2 — same
 *     inputs → same outputs, no `Date.now`, no timers). A throttle holds a live
 *     `setTimeout` handle and a window cursor; folding it into `update` would
 *     smuggle a timer into the pure core.
 *   - NOT a Sub. A Sub is a continuous SOURCE of Msgs the substrate reconciles
 *     by id every transition (invariant 4). A throttle is a SINK transformer:
 *     it wraps a `void`-returning handler (the canonical one is
 *     `Runtime.dispatch`) so a high-frequency HOST event is rate-limited BEFORE
 *     it ever becomes a Msg.
 *
 * It is a higher-order function at the host boundary (pattern 14 — TEA owns
 * state, JS owns timing). The host attaches the wrapped function to a
 * high-frequency event source (`mousemove`, `scroll`, `pointermove`, a game
 * loop) and the substrate downstream only ever sees the rate-limited Msg:
 *
 *   const onMoved = throttle(
 *     (e: PointerEvent) =>
 *       runtime.dispatch({ type: "UserMovedCursor", x: e.clientX, y: e.clientY }),
 *     16, // ~60fps cap
 *   );
 *   window.addEventListener("pointermove", onMoved);
 *   // cleanup: onMoved.cancel(); window.removeEventListener("pointermove", onMoved);
 *
 * NOT exported from the package root — reached via the `@demlik/tea/throttle`
 * subpath, same one-shape-per-package rule as `rate-limit`, `deadline`, and
 * `work-queue`.
 *
 * Uses the universal `setTimeout` / `clearTimeout` timer idiom (same discipline
 * as `subs/from-timeout.ts`): exactly one live handle at a time, the window
 * timer clears itself on expiry, `cancel` / `flush` clear and null it so a
 * stale callback can never run.
 */

/**
 * A throttled wrapper around `fn`. Callable with the SAME argument tuple as
 * `fn` — `(...args: A) => void` — plus two control methods that share names and
 * shapes with `Debounced<A>` so the two modules read as a symmetric pair.
 */
export interface Throttled<A extends readonly unknown[]> {
  /** Invoke `fn` if the window is open, else record args for the trailing fire. */
  (...args: A): void;
  /**
   * Drop any pending trailing fire WITHOUT invoking `fn`, and close the active
   * window. Clears the timer, forgets the captured trailing args, and resets
   * the cursor so the next call fires immediately on the leading edge (if
   * `leading` is enabled). Idempotent.
   *
   * The host-cleanup partner of `removeEventListener`: cancel the pending fire
   * when the component unmounts / the listener detaches, so a queued
   * `dispatch` can't land after teardown.
   */
  cancel(): void;
  /**
   * Fire any pending trailing call IMMEDIATELY with its latest captured args,
   * then close the window. No-op when nothing is pending. Use to force the last
   * dropped call out early — e.g. flush the final cursor position when a drag
   * ends, so the rest state isn't a stale mid-drag sample.
   */
  flush(): void;
}

/**
 * Wrap `fn` so it runs AT MOST once per `ms` window, no matter how often it is
 * called.
 *
 * Leading + trailing (the default): the first call fires `fn` IMMEDIATELY (the
 * leading edge) and opens a `ms` window. Calls during the window are dropped
 * from immediate firing but their args are remembered; when the window closes,
 * `fn` fires ONCE more with the LATEST dropped args (the trailing edge) and a
 * new window opens. A call after the window has already closed leads a fresh
 * window immediately. Spacing every call at least `ms` apart therefore fires
 * each one on its own leading edge.
 *
 * @param fn   The handler to rate-limit. Typically `(...) => runtime.dispatch(...)`,
 *             but any `(...args: A) => void` works. The return value is
 *             ignored — throttle is a fire transformer, not a value pipe.
 * @param ms   Window length in milliseconds. `fn` fires at most once per `ms`.
 * @param opts.leading   Fire on the FIRST call of a window (the leading edge),
 *             immediately. Default `true`.
 * @param opts.trailing  Fire once at window END with the latest args dropped
 *             during the window. Default `true`.
 *
 * Edge combinations (matching lodash's settled semantics, the de-facto
 * standard the ecosystem rediscovered):
 *
 *   - `{ leading: true, trailing: true }` (default): immediate fire + a
 *     trailing fire per window while calls keep arriving. The trailing fire is
 *     SUPPRESSED when no extra call arrived during the window (a lone call
 *     already fired on the leading edge — no stale trailing double-fire).
 *   - `{ leading: true, trailing: false }`: only the immediate fire; everything
 *     in the window is dropped with no catch-up at the end.
 *   - `{ leading: false, trailing: true }`: no immediate fire; the FIRST call
 *     opens a window and `fn` fires at the window's end with the latest args.
 *     Steady "sample every `ms`" behavior with no instant response.
 *   - `{ leading: false, trailing: false }`: never fires. Degenerate but legal;
 *     we don't throw — the caller asked for a no-op transformer.
 *
 * WHY a default of leading + trailing both `true`: a throttle's job is "respond
 * now, then keep responding at a steady rate." Leading gives the instant
 * response (the first `mousemove` updates immediately); trailing guarantees the
 * FINAL sample of a window isn't lost (the cursor ends where the user actually
 * left it, not one window-width behind). Dropping either loses one of those two
 * guarantees, so both default on.
 */
export function throttle<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  opts?: { leading?: boolean; trailing?: boolean },
): Throttled<A> {
  const leading = opts?.leading ?? true;
  const trailing = opts?.trailing ?? true;

  // Exactly one live handle at a time (the from-timeout discipline). `null`
  // when no window is open — the single source of truth for "is a window
  // active?". The window timer arms on a fire and clears itself on expiry; the
  // call path never stacks overlapping timers.
  let handle: ReturnType<typeof setTimeout> | null = null;
  // The latest args seen DURING an open window, held for the trailing fire.
  // Overwritten by every dropped call (the trailing edge fires with the LAST
  // args), cleared the instant we fire / cancel. `null` (not `undefined`) is
  // the empty sentinel because `A` may itself contain `undefined` elements — a
  // present-but-empty tuple is still a pending call, distinct from "nothing
  // pending".
  let pendingArgs: A | null = null;

  function clearHandle(): void {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  }

  // Window expiry: the `ms` window just closed. If a call arrived during the
  // window (`pendingArgs !== null`) and trailing is enabled, fire it now and
  // open a FRESH window so the rate cap continues across a sustained burst.
  // If nothing was dropped, let the window close (handle → null) so the next
  // call leads a new window immediately.
  function onWindowExpired(): void {
    if (trailing && pendingArgs !== null) {
      const args = pendingArgs;
      pendingArgs = null;
      // Re-arm BEFORE firing so a re-entrant call from inside `fn` sees an open
      // window (and is correctly dropped/queued) rather than leading a second
      // window — keeps the "at most once per `ms`" invariant under re-entry.
      handle = setTimeout(onWindowExpired, ms);
      fn(...args);
    } else {
      // No trailing fire owed — close the window.
      handle = null;
    }
  }

  const throttled = (...args: A): void => {
    if (handle === null) {
      // Window is closed → this call leads a new window.
      if (leading) {
        fn(...args);
      } else if (trailing) {
        // No leading fire, but trailing wants the first call's args so the
        // window's end has something to fire. Without this, a leading:false
        // throttle would swallow a lone call entirely.
        pendingArgs = args;
      }
      handle = setTimeout(onWindowExpired, ms);
    } else if (trailing) {
      // Window is open → drop this call from immediate firing, but remember its
      // args as the latest candidate for the trailing edge.
      pendingArgs = args;
    }
    // Window open + trailing disabled → pure drop, nothing to remember.
  };

  throttled.cancel = (): void => {
    clearHandle();
    pendingArgs = null;
  };

  throttled.flush = (): void => {
    // Force the pending trailing fire out now and close the window. Mirrors
    // `onWindowExpired`'s fire branch but is caller-driven, so it tears the
    // timer down rather than re-arming.
    if (pendingArgs !== null) {
      const args = pendingArgs;
      pendingArgs = null;
      clearHandle();
      fn(...args);
    } else {
      // Nothing pending — still close a lingering window so a post-flush call
      // leads cleanly.
      clearHandle();
    }
  };

  return throttled;
}
