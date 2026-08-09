import { describe, expect, it } from "vitest";
import {
  type Cmd as CmdType,
  defineMachine,
  type Interpret,
  type InterpretDetached,
  type Reducer,
  run,
  wrapDetached,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// `wrapDetached` — the typed Cmd→Msg edge for a handler that CANNOT return its
// terminal Msg inline (it hands the work to `ctx.waitUntil`, and awaiting it
// would deadlock the serial dispatch tail). Such a handler fires its terminal
// Msg through the kernel-injected `dispatch`, narrowed to the Cmd's declared
// result-Msg set so a wrong terminal Msg fails to COMPILE.
//
// The runtime half of that claim is what a test can reach: the kernel really
// does inject a dispatch, the Msg really does land on the same serial tail,
// and a handler invoked without the injected dispatch fails loudly instead of
// silently dropping the seam's result.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly phase: "idle" | "running" | "done" | "failed" };
type Finished = { readonly type: "graph_finished" };
type Failed = { readonly type: "graph_failed" };
type Msg = { readonly type: "go" } | Finished | Failed;
type Start = CmdType<"start_graph">;

// The detached handler, authored against the NARROWED dispatch: only
// `Finished | Failed` are reachable from here, and the type says so.
const startGraph: InterpretDetached<
  Start,
  Finished | Failed,
  undefined
> = async (_cmd, _ctx, dispatch) => {
  // Stand-in for `ctx.waitUntil(longRunningWork().then(...))` — the point is
  // that the terminal Msg leaves via `dispatch`, not via the return value.
  queueMicrotask(() => dispatch({ type: "graph_finished" }));
};

const update: Reducer<State, Msg, Start> = {
  go: () => [{ phase: "running" }, [{ type: "start_graph" }]],
  graph_finished: () => [{ phase: "done" }, []],
  graph_failed: () => [{ phase: "failed" }, []],
};

describe("wrapDetached — the typed Cmd→Msg edge", () => {
  it("fires the terminal Msg through the kernel-injected dispatch", async () => {
    const machine = defineMachine<State, Msg, Start, never, undefined>({
      init: () => [{ phase: "idle" }, []],
      update,
      interpret: { start_graph: wrapDetached(startGraph) } satisfies Interpret<
        Msg,
        Start,
        undefined
      >,
    });

    const rt = await run(machine, { ctx: undefined }).ready;
    await rt.dispatch({ type: "go" });
    await rt.idle();

    expect(rt.getState().phase).toBe("done");
  });

  it("the wrapped handler resolves without returning a Msg (it is a void edge)", async () => {
    const wrapped = wrapDetached<Start, Msg, Finished | Failed, undefined>(
      startGraph,
    );
    const fired: Msg[] = [];
    const result = await wrapped(
      { type: "start_graph" },
      { emit: () => {} },
      (m) => fired.push(m),
    );
    expect(result).toBeUndefined();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(fired).toEqual([{ type: "graph_finished" }]);
  });

  it("throws loudly when invoked WITHOUT the injected dispatch", async () => {
    // Only a mis-wired direct caller can reach this: the kernel always passes
    // the dispatch. Failing loudly beats silently dropping the seam's result.
    const wrapped = wrapDetached<Start, Msg, Finished | Failed, undefined>(
      startGraph,
    );
    expect(() => wrapped({ type: "start_graph" }, { emit: () => {} })).toThrow(
      /without the injected dispatch/,
    );
  });

  it("the injected dispatch enqueues on the SAME serial tail (no re-entrancy)", async () => {
    // The handler dispatches synchronously, mid-interpret. If the injected
    // dispatch re-entered the reducer instead of enqueueing, the transition
    // would nest and `phase` would end up "running" (the outer commit landing
    // last). Serial enqueue means the terminal transition wins.
    const reentrant: InterpretDetached<
      Start,
      Finished | Failed,
      undefined
    > = async (_cmd, _ctx, dispatch) => {
      dispatch({ type: "graph_finished" });
    };
    const machine = defineMachine<State, Msg, Start, never, undefined>({
      init: () => [{ phase: "idle" }, []],
      update,
      interpret: { start_graph: wrapDetached(reentrant) } satisfies Interpret<
        Msg,
        Start,
        undefined
      >,
    });

    const rt = await run(machine, { ctx: undefined }).ready;
    await rt.dispatch({ type: "go" });
    await rt.idle();
    expect(rt.getState().phase).toBe("done");
  });

  it("a plain leaf handler ignores the third arg entirely (additive)", async () => {
    // The pre-existing authoring style: return the follow-up Msg, declare only
    // `(cmd, ctx)`. Still assignable, still works.
    const machine = defineMachine<State, Msg, Start, never, undefined>({
      init: () => [{ phase: "idle" }, []],
      update,
      interpret: {
        start_graph: async () => ({ type: "graph_finished" }) as const,
      } satisfies Interpret<Msg, Start, undefined>,
    });

    const rt = await run(machine, { ctx: undefined }).ready;
    await rt.dispatch({ type: "go" });
    await rt.idle();
    expect(rt.getState().phase).toBe("done");
  });
});
