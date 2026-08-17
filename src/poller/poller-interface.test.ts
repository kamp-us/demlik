// ═══════════════════════════════════════════════════════════════════════════
// THE `Poller` INTERFACE IS IMPLEMENTABLE BY HAND.
//
// `Poller<State, R>` is published, so a consumer may write one themselves — a
// clock-free stub in a test, a poller driven by a different scheduler, a mock
// standing in for the real knob. That only works if a plain, NON-generic object
// literal is assignable to it.
//
// A generic method whose return type mentions its own type parameter states an
// identity no non-generic body can satisfy:
//
//     tick<S extends PollerState<R>>(state: S): readonly [S, readonly Cmd[]]
//
//     TS2322: '<S extends PollerState<number>>(_s: PollerState<number>) =>
//       readonly [PollerState<number>, readonly Cmd[]]' is not assignable to
//       '<S extends PollerState<number>>(state: S) => readonly [S, readonly Cmd[]]'.
//         'PollerState<number>' is assignable to the constraint of type 'S', but
//         'S' could be instantiated with a DIFFERENT subtype.
//
// …so declaring `tick` generic locked every consumer out of the interface. The
// declarations below are exactly what such a consumer writes; this file is a
// TYPE regression first (it must keep compiling under `pnpm typecheck:test`)
// and a behavioural one second.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { initStore } from "../idempotency";
import type { Cmd } from "../index";
import {
  createPoller,
  type Poller,
  type PollerPolling,
  type PollerState,
} from "./index";

type Status = { readonly status: "pending" | "ready" };
type Slice = { readonly poll: PollerState<Status> };

const FETCH: Cmd<"fetch_status"> = { type: "fetch_status" };
const BASE = 1_000_000;

const empty = (): PollerPolling<Status> => ({
  phase: "polling",
  tick: 0,
  retry: { attempt: 0 },
  nextAtMs: null,
  dedupe: initStore<true>(),
});

/**
 * The method the generic made unwritable, written the way a consumer really
 * writes one: a NAMED function with its own explicit annotation, not an inline
 * arrow the object literal can contextually type into `S`. That distinction is
 * the whole defect — an inline arrow silently infers `S` and slips past, so a
 * regression written that way would not have bitten. A separately-declared
 * implementation (a class method, an imported helper, a `vi.fn()` cast) is what
 * TS2322s against a `tick<S extends PollerState<R>>(state: S) => [S, …]`.
 */
function stubTick(
  state: PollerState<Status>,
): readonly [PollerState<Status>, readonly Cmd[]] {
  return state.phase === "polling" ? [state, [FETCH]] : [state, []];
}

describe("the Poller interface", () => {
  it("accepts a hand-written, non-generic implementation", () => {
    const stub: Poller<Slice, Status> = {
      init: empty,
      start: (s, at) => [{ ...s, phase: "polling", nextAtMs: at + 1_000 }, []],
      tick: stubTick,
      tickResult: (s, result, at) => [
        { ...s, phase: "polling", lastResult: result, nextAtMs: at },
        [],
      ],
      tickErr: (s) => [{ ...s, phase: "gave_up" }, []],
      subs: () => [],
    };

    const seeded = stub.init();
    expect(seeded.phase).toBe("polling");
    expect(stub.start(seeded, BASE)[0].nextAtMs).toBe(BASE + 1_000);
    expect(stub.tick(seeded)).toEqual([seeded, [FETCH]]);
    expect(stub.tickErr(seeded, "boom", BASE)[0].phase).toBe("gave_up");
  });

  it("is satisfied by the real knob under the same annotation", () => {
    // The factory's own return value, pinned through the published interface —
    // so a future widening of `createPoller` that no longer matches `Poller`
    // fails here rather than only at a consumer's call site.
    const real: Poller<Slice, Status> = createPoller<Slice, Status>({
      everyMs: 5_000,
      until: (s) => s.poll.lastResult?.status === "ready",
      onTick: () => FETCH,
    });
    const [armed] = real.start(real.init(), BASE);
    expect(armed.nextAtMs).toBe(BASE + 5_000);
    expect(real.tick(armed)[1]).toEqual([FETCH]);
  });
});
