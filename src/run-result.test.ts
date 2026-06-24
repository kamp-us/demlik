import { describe, expect, it } from "vitest";
import { defineMachine, type Interpret, type Reducer, run } from "./index";

// ───────────────────────────────────────────────────────────────────────────
// First-class run result (#46): `Runtime.result()` / `Runtime.done()`, driven
// by the `terminal` predicate passed to `run()`. The run's outcome is read off
// the State the machine owns — never scraped off the `observe` firehose by
// matching an internal Msg name and racing a state-clear.
// ───────────────────────────────────────────────────────────────────────────

// A trivial counter that finishes once it reaches a threshold. `output` is the
// value the run produced; `phase` flips to "done" at the threshold.
type State = {
  readonly phase: "running" | "done";
  readonly count: number;
  readonly output: string | null;
};
type Msg = { readonly type: "bump" } | { readonly type: "finish" };

function counterMachine() {
  const update: Reducer<State, Msg, never> = {
    bump: (s) => [{ ...s, count: s.count + 1 }, []],
    finish: (s) => [{ ...s, phase: "done", output: `done@${s.count}` }, []],
  };
  return defineMachine<State, Msg, never, never, undefined>({
    init: () => [{ phase: "running", count: 0, output: null }, []],
    update,
    interpret: {} as Interpret<Msg, never, undefined>,
  });
}

const isDone = (s: State): boolean => s.phase === "done";

describe("Runtime.result() — the terminal-State read (#46)", () => {
  it("returns undefined while running, the State once terminal", async () => {
    const rt = await run(counterMachine(), {
      ctx: undefined,
      terminal: isDone,
    }).ready;

    expect(rt.result()).toBeUndefined(); // fresh boot → not terminal
    await rt.dispatch({ type: "bump" });
    expect(rt.result()).toBeUndefined(); // still running
    await rt.dispatch({ type: "finish" });

    const result = rt.result();
    expect(result).not.toBeUndefined();
    expect(result?.phase).toBe("done");
    expect(result?.output).toBe("done@1");
  });

  it("is always undefined when no terminal predicate is supplied", async () => {
    const rt = await run(counterMachine(), { ctx: undefined }).ready;
    await rt.dispatch({ type: "finish" }); // State IS done…
    expect(rt.result()).toBeUndefined(); // …but no predicate → never terminal
  });
});

describe("Runtime.done() — the awaitable terminal result (#46)", () => {
  it("resolves with the terminal State on the finishing transition", async () => {
    const rt = await run(counterMachine(), {
      ctx: undefined,
      terminal: isDone,
    }).ready;

    const done = rt.done(); // parked before terminal
    await rt.dispatch({ type: "bump" });
    await rt.dispatch({ type: "finish" }); // makes `isDone` hold → resolves

    const final = await done;
    expect(final.phase).toBe("done");
    expect(final.output).toBe("done@1");
  });

  it("resolves immediately when called AFTER the run is already terminal", async () => {
    const rt = await run(counterMachine(), {
      ctx: undefined,
      terminal: isDone,
    }).ready;
    await rt.dispatch({ type: "finish" });

    // Already terminal — `done()` must resolve at once, never miss the
    // transition it was called after.
    const final = await rt.done();
    expect(final.output).toBe("done@0");
  });

  it("settles every concurrent waiter on the same terminal transition", async () => {
    const rt = await run(counterMachine(), {
      ctx: undefined,
      terminal: isDone,
    }).ready;

    const a = rt.done();
    const b = rt.done();
    await rt.dispatch({ type: "finish" });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.output).toBe("done@0");
    expect(rb).toEqual(ra);
  });
});
