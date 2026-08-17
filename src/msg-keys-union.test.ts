import { describe, expect, it } from "vitest";
import {
  applyCell,
  defineMachine,
  type Interpret,
  msgKeysOf,
  NoCellError,
  type Reducer,
  type Transitions,
} from "./index";
import { withDeadline } from "./with-deadline";
import { withTelemetry } from "./with-telemetry";

// ───────────────────────────────────────────────────────────────────────────
// `msgKeysOf` over a RAGGED Transitions table.
//
// The old reading took `Object.keys(update)[0]` and returned that ONE row's
// inner keys, justified by the mapped-type contract making the Msg key set
// uniform across phases. That holds where the types hold — a hand-written
// TOTAL table. It does not hold for a table assembled dynamically with the
// discriminants widened to plain `string`, which is exactly what a machine
// built at runtime from config looks like: the mapped type constrains nothing
// and the rows are structurally ragged.
//
// The consequence is not cosmetic. All three `withX` wrappers build their
// merged flat Reducer by iterating `msgKeysOf(base)`, so a Msg absent from row
// zero got NO cell in the wrapped machine and threw `NoCellError` on dispatch
// for a Msg the BASE handles fine. `withDeadline`'s reserved-namespace scan
// missed a `$deadline:`-prefixed Msg living only in a later row for the same
// reason.
//
// These tests pin both halves: the union is now reported (widening), and a
// total table's answer is identical to before (no behaviour change).
// ───────────────────────────────────────────────────────────────────────────

// A ragged table, built the way a dynamic machine builder builds one: both
// discriminants are plain `string`, so `Transitions<S, M, C>`'s mapped type
// enforces no uniformity and rows legitimately differ. "late" appears ONLY in
// the second row — the key the old first-row reading could never see.
type DynState = { readonly type: string };
type DynMsg = { readonly type: string };

function raggedTable(): Record<
  string,
  Record<string, (s: DynState, m: DynMsg) => readonly [DynState, readonly []]>
> {
  return {
    idle: {
      start: () => [{ type: "busy" }, []],
    },
    busy: {
      start: (s) => [s, []],
      late: () => [{ type: "idle" }, []],
    },
  };
}

function raggedMachine() {
  return defineMachine<DynState, DynMsg, never, never, undefined>({
    init: () => [{ type: "idle" }, []],
    update: raggedTable() as unknown as Transitions<DynState, DynMsg, never>,
    interpret: {} as Interpret<DynMsg, never, undefined>,
  });
}

// The old implementation, verbatim, so the "was broken" claim is a live
// assertion in the suite rather than a sentence in a commit message.
function msgKeysOfFirstRowOnly(update: object): readonly string[] {
  const keys = Object.keys(update);
  const firstKey = keys[0];
  if (firstKey === undefined) return [];
  const firstValue = (update as Record<string, unknown>)[firstKey];
  return Object.keys(firstValue as object);
}

describe("msgKeysOf — ragged Transitions table", () => {
  it("reports the UNION of every row's Msg keys, not just row zero's", () => {
    const m = raggedMachine();
    expect(msgKeysOf(m)).toEqual(["start", "late"]);
  });

  it("the previous first-row reading under-reported — the regression it fixes", () => {
    // Proof the ragged case was actually broken, not hypothetically broken.
    expect(msgKeysOfFirstRowOnly(raggedMachine().update)).toEqual(["start"]);
    expect(msgKeysOfFirstRowOnly(raggedMachine().update)).not.toContain("late");
  });

  it("is order-stable and deduped: first-seen order across rows", () => {
    const update = {
      a: { one: () => [{ type: "a" }, []] as const },
      b: {
        two: () => [{ type: "b" }, []] as const,
        one: () => [{ type: "b" }, []] as const,
      },
      c: { three: () => [{ type: "c" }, []] as const },
    };
    expect(msgKeysOf({ update, __form: "transitions" })).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("still returns [] for an empty update", () => {
    expect(msgKeysOf({ update: {}, __form: "transitions" })).toEqual([]);
    expect(msgKeysOf({ update: {} })).toEqual([]);
  });

  it("skips a nullish row instead of throwing", () => {
    const update = { a: { one: () => 0 }, b: undefined, c: { two: () => 0 } };
    expect(msgKeysOf({ update, __form: "transitions" })).toEqual([
      "one",
      "two",
    ]);
  });
});

describe("msgKeysOf — total tables and reducers are UNCHANGED (pure widening)", () => {
  type LightState = { readonly type: "red" } | { readonly type: "green" };
  type LightMsg = { readonly type: "go" } | { readonly type: "stop" };

  it("a TOTAL Transitions table yields exactly the first row's keys, same order", () => {
    const update: Transitions<LightState, LightMsg, never> = {
      red: { go: () => [{ type: "green" }, []], stop: (s) => [s, []] },
      green: { go: (s) => [s, []], stop: () => [{ type: "red" }, []] },
    };
    const m = defineMachine<LightState, LightMsg, never, never, undefined>({
      init: () => [{ type: "red" }, []],
      update,
      interpret: {} as Interpret<LightMsg, never, undefined>,
    });
    // The union and the old first-row reading agree — that is what "total"
    // means, and it is why the widening cannot change any existing machine.
    expect(msgKeysOf(m)).toEqual(["go", "stop"]);
    expect(msgKeysOf(m)).toEqual(msgKeysOfFirstRowOnly(m.update));
  });

  it("a Reducer's own keys are still returned verbatim", () => {
    type S = { readonly count: number };
    type M = { readonly type: "bump" } | { readonly type: "reset" };
    const update: Reducer<S, M, never> = {
      bump: (s) => [{ count: s.count + 1 }, []],
      reset: () => [{ count: 0 }, []],
    };
    const m = defineMachine<S, M, never, never, undefined>({
      init: () => [{ count: 0 }, []],
      update,
    });
    expect(msgKeysOf(m)).toEqual(["bump", "reset"]);
  });
});

describe("the wrappers stop losing cells for a ragged base", () => {
  it("withTelemetry builds a cell for a Msg that lives only in a later row", () => {
    const wrapped = withTelemetry(raggedMachine());
    // The under-enumeration bug surfaced HERE: no cell for "late" in the
    // wrapped flat record → NoCellError at dispatch for a Msg the base
    // handles. Stepping the wrapped machine must now succeed.
    const [next] = applyCell<
      { base: DynState; $telemetry: { seq: number } },
      DynMsg,
      never
    >(
      wrapped,
      { base: { type: "busy" }, $telemetry: { seq: 0 } },
      { type: "late" },
    );
    expect(next.base).toEqual({ type: "idle" });

    // And the failure is still real for a Msg NO row declares — the widening
    // did not turn the guard off.
    expect(() =>
      applyCell(
        wrapped,
        { base: { type: "busy" }, $telemetry: { seq: 0 } },
        { type: "nonexistent" },
      ),
    ).toThrow(NoCellError);
  });

  it("withDeadline's reserved-namespace scan sees a later row's $deadline: Msg", () => {
    const squatter = defineMachine<DynState, DynMsg, never, never, undefined>({
      init: () => [{ type: "idle" }, []],
      update: {
        idle: { start: () => [{ type: "busy" }, []] },
        // The squat hides in row TWO — invisible to the first-row reading, so
        // the wrapper used to accept the base and then silently clobber it.
        busy: { "$deadline:exceeded": (s: DynState) => [s, []] },
      } as unknown as Transitions<DynState, DynMsg, never>,
      interpret: {} as Interpret<DynMsg, never, undefined>,
    });
    expect(() => withDeadline(squatter, { ms: 10 })).toThrow(/\$deadline:/);
  });
});
