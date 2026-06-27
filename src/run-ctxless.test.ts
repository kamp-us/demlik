/**
 * `run()` — a pure machine needs no `ctx` (#182).
 *
 * Before this, a context-free reducer still had to write `ctx: {}` (vortex's
 * arena grain passes exactly that, `Ctx = Record<string, never>`). `ctx` is now
 * conditionally optional (see `CtxArg`): a machine whose `Ctx` is satisfiable by
 * the empty object runs with no `ctx` at all. This is the RUNTIME half; the
 * compile-time half (omission allowed for pure `Ctx`, still required for a
 * context-bearing `Ctx`) lives in `__tests__/run-ctxless.test-d.ts`.
 */

import { describe, expect, it } from "vitest";
import { defineMachine, type NoCtx, type Reducer, run } from "./index";

type State = { readonly count: number };
type Msg = { readonly type: "bump" };

function pureMachine() {
  const update: Reducer<State, Msg, never> = {
    bump: (s) => [{ count: s.count + 1 }, []],
  };
  return defineMachine<State, Msg, never, never, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
  });
}

describe("run() — pure machine, no ctx (#182)", () => {
  it("boots and dispatches with no ctx passed", async () => {
    const rt = await run(pureMachine(), {}).ready;
    expect(rt.getState().count).toBe(0);
    await rt.dispatch({ type: "bump" });
    await rt.dispatch({ type: "bump" });
    expect(rt.getState().count).toBe(2);
  });

  it("still accepts an explicit ctx (additive — vortex's `ctx: {}` path)", async () => {
    const rt = await run(pureMachine(), { ctx: {} }).ready;
    await rt.dispatch({ type: "bump" });
    expect(rt.getState().count).toBe(1);
  });

  it("the omitted-ctx default still composes with other opts (store/terminal)", async () => {
    // No ctx, but a terminal predicate — proves the default doesn't disturb the
    // rest of the opts bag.
    const rt = await run(pureMachine(), {
      terminal: (s) => s.count >= 1,
    }).ready;
    expect(rt.result()).toBeUndefined();
    await rt.dispatch({ type: "bump" });
    expect(rt.result()?.count).toBe(1);
  });
});
