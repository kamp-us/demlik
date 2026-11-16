import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { identityCases } from "./__fixtures__/engine-conformance";
import {
  applyCell,
  defineMachine,
  type Identity,
  IdentityDropNotice,
  matchesIdentity,
  type Reducer,
  RuntimeDiscardNotice,
} from "./index";
import { run } from "./promise";

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
  | { readonly _tag: "claim"; readonly runId: string }
  | { readonly _tag: "work"; readonly runId: string }
  | { readonly _tag: "ping" };

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
  ofMsg: (m) => (m._tag === "ping" ? undefined : m.runId),
};

function machine(withIdentity: boolean) {
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg, ctx: undefined },
    init: () => [{ runId: null, applied: [] }, []],
    update,
    ...(withIdentity ? { identity } : {}),
  });
}

describe("Identity — the kernel-enforced mis-addressed drop", () => {
  it("drops a message addressed to a different identity before `update` runs", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });

    await rt.dispatch({ _tag: "work", runId: "r2" }); // foreign run
    expect(rt.getState().applied).toEqual(["claim"]);
  });

  it("delivers a message addressed to THIS identity", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });

    await rt.dispatch({ _tag: "work", runId: "r1" });
    expect(rt.getState().applied).toEqual(["claim", "work"]);
  });

  it("resolves the dropped dispatch instead of rejecting, and fires nothing", async () => {
    const seen: Msg[] = [];
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });
    rt.observe((msg) => seen.push(msg));
    let listenerFires = 0;
    rt.subscribe(() => {
      listenerFires += 1;
    });

    // A drop is not an error — it resolves, advances nothing, and is invisible
    // to observers and listeners.
    await expect(
      rt.dispatch({ _tag: "work", runId: "r2" }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
    expect(listenerFires).toBe(0);
  });

  it("never drops an identity-agnostic message (`ofMsg` → undefined)", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });

    await rt.dispatch({ _tag: "ping" });
    expect(rt.getState().applied).toEqual(["claim", "ping"]);
  });

  it("never drops the message that ESTABLISHES the identity (`ofState` → undefined)", async () => {
    const rt = await run(machine(true), { ctx: undefined }).ready;
    // Fresh boot: this instance owns no identity yet, so an addressed message
    // is identity-establishing, not foreign.
    await rt.dispatch({ _tag: "claim", runId: "r1" });
    expect(rt.getState().runId).toBe("r1");
  });

  it("compares identities structurally, so field order is not a foreign run", async () => {
    type CompositeState = {
      readonly key: { a: string; b: string } | null;
      readonly hits: number;
    };
    type CompositeMsg = {
      readonly _tag: "hit";
      readonly key: { b: string; a: string };
    };
    const rt = await run(
      defineMachine({
        types: {
          model: {} as CompositeState,
          msg: {} as CompositeMsg,
          ctx: undefined,
        },
        init: () => [{ key: { a: "1", b: "2" }, hits: 0 }, []],
        // `hits` is what makes the drop observable — a state-preserving cell
        // would look identical whether the Msg landed or was filtered out.
        update: { hit: (s) => [{ ...s, hits: s.hits + 1 }, []] },
        identity: {
          ofState: (s) => s.key ?? undefined,
          ofMsg: (m) => m.key,
        },
      }),
      { ctx: undefined },
    ).ready;

    // Same identity, keys written in the other order — must NOT be dropped.
    // A reference/`===` comparison would drop this; a structural one delivers.
    await rt.dispatch({ _tag: "hit", key: { b: "2", a: "1" } });
    expect(rt.getState().hits).toBe(1);

    // …and a genuinely different composite identity IS dropped.
    await rt.dispatch({ _tag: "hit", key: { b: "9", a: "1" } });
    expect(rt.getState().hits).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The drop is REPORTED. A dispatch that was filtered out resolves like an
// applied one, so the caller cannot tell them apart — a reusable Durable
// Object serving run A and then run B would lose run B and report success.
// The drop rides the `OnError` sink as an `IdentityDropNotice`
// (`RuntimeDiscardNotice` — warn-by-default, never fatal), which is what makes
// "the ONE observable enforcement point" true rather than aspirational.
// ───────────────────────────────────────────────────────────────────────────
describe("Identity — the drop is observable", () => {
  it("reports a mis-addressed drop to the `onError` sink", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    const rt = await run(machine(true), {
      ctx: undefined,
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });

    await rt.dispatch({ _tag: "work", runId: "r2" });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.phase).toBe("identity-drop");
    const error = reports[0]?.error;
    // A `RuntimeDiscardNotice` subclass is what makes the default sink WARN
    // instead of rethrowing — an identity drop must never take a host down.
    expect(error).toBeInstanceOf(IdentityDropNotice);
    expect(error).toBeInstanceOf(RuntimeDiscardNotice);
    if (!(error instanceof IdentityDropNotice)) throw new Error("unreachable");
    expect(error.msgType).toBe("work");
  });

  it("is NOT fatal — the dispatch still resolves and the runtime keeps folding", async () => {
    const reports: unknown[] = [];
    const rt = await run(machine(true), {
      ctx: undefined,
      onError: (error) => reports.push(error),
    }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });

    await expect(
      rt.dispatch({ _tag: "work", runId: "r2" }),
    ).resolves.toBeUndefined();
    await rt.dispatch({ _tag: "work", runId: "r1" });
    expect(rt.getState().applied).toEqual(["claim", "work"]);
    expect(reports).toHaveLength(1);
  });

  it("reports nothing when the message is delivered", async () => {
    const reports: unknown[] = [];
    const rt = await run(machine(true), {
      ctx: undefined,
      onError: (error) => reports.push(error),
    }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });
    await rt.dispatch({ _tag: "work", runId: "r1" });
    await rt.dispatch({ _tag: "ping" });
    expect(reports).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The identity projection is user code, so it can throw — and it must be
// supervised exactly like the reducer is. `structuralHash` throwing on a
// non-plain identity (a Date, a bigint snowflake id) puts EVERY dispatch on
// this path, so an unprotected projection would take the runtime down with no
// report and no strategy.
// ───────────────────────────────────────────────────────────────────────────
describe("Identity — a throwing projection is supervised, not raw", () => {
  const throwing = (which: "ofState" | "ofMsg") =>
    defineMachine({
      types: { model: {} as State, msg: {} as Msg, ctx: undefined },
      init: () => [{ runId: "r1", applied: [] }, []],
      update,
      identity: {
        ofState: (s) => {
          if (which === "ofState") throw new Error("projection blew up");
          return s.runId ?? undefined;
        },
        ofMsg: (m) => {
          if (which === "ofMsg") throw new Error("projection blew up");
          return m._tag === "ping" ? undefined : m.runId;
        },
      },
    });

  it('routes an `ofMsg` throw through the sink under `phase: "reduce"`', async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    const rt = await run(throwing("ofMsg"), {
      ctx: undefined,
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;

    await expect(rt.dispatch({ _tag: "work", runId: "r1" })).rejects.toThrow(
      /projection blew up/,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.phase).toBe("reduce");
  });

  it("routes an `ofState` throw through the declared supervision strategy", async () => {
    const reports: unknown[] = [];
    const rt = await run(throwing("ofState"), {
      ctx: undefined,
      onError: (error) => reports.push(error),
      supervision: {
        strategy: "restart",
        rehydrate: (s) => ({ ...s, applied: [...s.applied, "rehydrated"] }),
      },
    }).ready;

    // `restart` means the transition CONTINUES from host-supplied state — the
    // dispatch resolves, exactly as it does for a throwing reducer.
    await rt.dispatch({ _tag: "work", runId: "r1" });
    expect(rt.getState().applied).toEqual(["rehydrated"]);
    expect(reports).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F1a: with a non-plain identity every value hashed to `"{}"`, so the filter
// admitted EVERY foreign message while reporting itself as enabled — data
// corruption with the guard switched on. The hash now refuses the value, so
// the failure is loud instead.
// ───────────────────────────────────────────────────────────────────────────
describe("Identity — a non-plain identity fails loudly, never permissively", () => {
  type DateState = {
    readonly startedAt: Date | null;
    readonly applied: number;
  };
  type DateMsg = { readonly _tag: "work"; readonly startedAt: Date };

  const dateMachine = defineMachine({
    types: { model: {} as DateState, msg: {} as DateMsg, ctx: undefined },
    init: () => [{ startedAt: new Date(1_000), applied: 0 }, []],
    update: { work: (s) => [{ ...s, applied: s.applied + 1 }, []] },
    identity: {
      ofState: (s) => s.startedAt ?? undefined,
      ofMsg: (m) => m.startedAt,
    },
  });

  it("does not admit a foreign run's message just because both identities are Dates", async () => {
    const reports: unknown[] = [];
    const rt = await run(dateMachine, {
      ctx: undefined,
      onError: (error) => reports.push(error),
    }).ready;

    await expect(
      rt.dispatch({ _tag: "work", startedAt: new Date(9_999) }),
    ).rejects.toThrow(/non-plain object/);
    expect(rt.getState().applied).toBe(0);
    expect(reports).toHaveLength(1);
  });
});

describe("Identity — additivity", () => {
  it("a machine that declares no `identity` is completely unfiltered", async () => {
    const rt = await run(machine(false), { ctx: undefined }).ready;
    await rt.dispatch({ _tag: "claim", runId: "r1" });
    // The exact message the identity-declaring machine drops.
    await rt.dispatch({ _tag: "work", runId: "r2" });
    expect(rt.getState().applied).toEqual(["claim", "work"]);
  });
});

describe("matchesIdentity — manual hosts agree with the Promise engine", () => {
  it.each(identityCases)("$name", async ({
    machine,
    initial,
    script: [msg],
    allowed,
  }) => {
    const matches = matchesIdentity(machine.identity, initial, msg);
    expect(matches).toBe(allowed);

    const reports: unknown[] = [];
    const rt = await run(machine, {
      ctx: undefined,
      onError: (error) => reports.push(error),
    }).ready;
    try {
      await rt.dispatch(msg);
      expect(rt.getState().pokes === 0).toBe(!matches);
      expect(reports).toHaveLength(matches ? 0 : 1);
      for (const report of reports)
        expect(report).toBeInstanceOf(IdentityDropNotice);
    } finally {
      await rt.stop();
    }
  });

  it("a manual stepper filters 1,000 generated messages exactly like the engine", async () => {
    const msg: fc.Arbitrary<Msg> = fc.oneof(
      fc.record({
        _tag: fc.constant<"claim">("claim"),
        runId: fc.constantFrom("r1", "r2", "r3"),
      }),
      fc.record({
        _tag: fc.constant<"work">("work"),
        runId: fc.constantFrom("r1", "r2", "r3"),
      }),
      fc.constant<Msg>({ _tag: "ping" }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(msg, { minLength: 1_000, maxLength: 1_000 }),
        async (msgs) => {
          const stepped = machine(true);
          let state: State = { runId: null, applied: [] };
          const seen: Msg[] = [];
          const applied: Msg[] = [];
          const rt = await run(stepped, { ctx: undefined, onError: () => {} })
            .ready;
          rt.observe((msg) => seen.push(msg));
          try {
            for (const msg of msgs) {
              const matches = matchesIdentity(stepped.identity, state, msg);
              if (matches) {
                [state] = applyCell<State, Msg, never>(stepped, state, msg);
                applied.push(msg);
              }
              const before = seen.length;
              await rt.dispatch(msg);
              expect(seen.length - before).toBe(matches ? 1 : 0);
            }
            expect(applied).toEqual(seen);
            expect(state).toEqual(rt.getState());
          } finally {
            await rt.stop();
          }
        },
      ),
      { numRuns: 10 },
    );
  });
});
