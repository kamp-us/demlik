import { describe, expect, it } from "vitest";
import {
  defineMachine,
  type Identity,
  type Interpret,
  type Reducer,
  run,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// The instance-identity filter. Declared once on the machine, enforced by the
// kernel at ONE observable point, replacing the per-cell
// `if (msg.runId !== state.runId) return [state, []]` guard that only works
// until someone forgets a cell. What matters:
//
//   - a message addressed to a DIFFERENT identity never reaches `update`;
//   - an identity-agnostic message (`ofMsg` → undefined) always does;
//   - a state with no identity yet cannot drop the message that establishes it;
//   - a machine that declares no `identity` is completely unfiltered.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly runId: string | null; readonly applied: string[] };
type Msg =
  | { readonly type: "claim"; readonly runId: string }
  | { readonly type: "work"; readonly runId: string }
  | { readonly type: "ping" };

const update: Reducer<State, Msg, never> = {
  claim: (s, m) => [
    { ...s, runId: m.runId, applied: [...s.applied, "claim"] },
    [],
  ],
  work: (s) => [{ ...s, applied: [...s.applied, "work"] }, []],
  ping: (s) => [{ ...s, applied: [...s.applied, "ping"] }, []],
};

// `ofMsg` narrows per arm in author-land: the lifecycle arm returns undefined,
// the addressed arms return their runId. The kernel never reaches into a field
// it cannot type.
const identity: Identity<State, Msg> = {
  ofState: (s) => s.runId ?? undefined,
  ofMsg: (m) => (m.type === "ping" ? undefined : m.runId),
};

function machine(withIdentity: boolean) {
  return defineMachine<State, Msg, never, never, undefined>({
    init: () => [{ runId: null, applied: [] }, []],
    update,
    ...(withIdentity ? { identity } : {}),
    interpret: {} as Interpret<Msg, never, undefined>,
  });
}

describe("Identity — the kernel-enforced mis-addressed drop", () => {
  it("drops a message addressed to a different identity before `update` runs", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ type: "claim", runId: "r1" });

    await rt.dispatch({ type: "work", runId: "r2" }); // foreign run
    expect(rt.getState().applied).toEqual(["claim"]);
  });

  it("delivers a message addressed to THIS identity", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ type: "claim", runId: "r1" });

    await rt.dispatch({ type: "work", runId: "r1" });
    expect(rt.getState().applied).toEqual(["claim", "work"]);
  });

  it("resolves the dropped dispatch instead of rejecting, and fires nothing", async () => {
    const seen: Msg[] = [];
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ type: "claim", runId: "r1" });
    rt.observe((msg) => seen.push(msg));
    let listenerFires = 0;
    rt.subscribe(() => {
      listenerFires += 1;
    });

    // A drop is not an error — it resolves, advances nothing, and is invisible
    // to observers and listeners.
    await expect(
      rt.dispatch({ type: "work", runId: "r2" }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
    expect(listenerFires).toBe(0);
  });

  it("never drops an identity-agnostic message (`ofMsg` → undefined)", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ type: "claim", runId: "r1" });

    await rt.dispatch({ type: "ping" });
    expect(rt.getState().applied).toEqual(["claim", "ping"]);
  });

  it("never drops the message that ESTABLISHES the identity (`ofState` → undefined)", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    // Fresh boot: this instance owns no identity yet, so an addressed message
    // is identity-establishing, not foreign.
    await rt.dispatch({ type: "claim", runId: "r1" });
    expect(rt.getState().runId).toBe("r1");
  });

  it("compares identities structurally, so field order is not a foreign run", async () => {
    type CompositeState = {
      readonly key: { a: string; b: string } | null;
      readonly hits: number;
    };
    type CompositeMsg = {
      readonly type: "hit";
      readonly key: { b: string; a: string };
    };
    const rt = await run(
      defineMachine<CompositeState, CompositeMsg, never, never, undefined>({
        init: () => [{ key: { a: "1", b: "2" }, hits: 0 }, []],
        // `hits` is what makes the drop observable — a state-preserving cell
        // would look identical whether the Msg landed or was filtered out.
        update: { hit: (s) => [{ ...s, hits: s.hits + 1 }, []] },
        identity: {
          ofState: (s) => s.key ?? undefined,
          ofMsg: (m) => m.key,
        },
        interpret: {} as Interpret<CompositeMsg, never, undefined>,
      }),
      { ctx: undefined },
    ).ready;

    // Same identity, keys written in the other order — must NOT be dropped.
    // A reference/`===` comparison would drop this; a structural one delivers.
    await rt.dispatch({ type: "hit", key: { b: "2", a: "1" } });
    expect(rt.getState().hits).toBe(1);

    // …and a genuinely different composite identity IS dropped.
    await rt.dispatch({ type: "hit", key: { b: "9", a: "1" } });
    expect(rt.getState().hits).toBe(1);
  });
});

describe("Identity — additivity", () => {
  it("a machine that declares no `identity` is completely unfiltered", async () => {
    const rt = await run(machine(false), { ctx: undefined }).ready;
    await rt.dispatch({ type: "claim", runId: "r1" });
    // The exact message the identity-declaring machine drops.
    await rt.dispatch({ type: "work", runId: "r2" });
    expect(rt.getState().applied).toEqual(["claim", "work"]);
  });
});
