// ═══════════════════════════════════════════════════════════════════════════
// #21 (folded into #20) — `acceptedTypes(machine, state)`: ask BEFORE you act.
//
// `NoCellError` now names the refusing state's accepted set, which answers the
// question after the fact. A caller deciding whether to dispatch at all — a CLI
// rendering the legal next moves, a queue draining a log against a machine that
// may have reached a final state — needs the same answer without provoking a
// throw it then has to catch and discard.
//
// The load-bearing promise is that the two answers are ONE reading, not two
// that happen to agree today: `lookupCell`'s miss arm calls this very function,
// so the property below cannot be satisfied by a second implementation that
// drifts. It is asserted as a property rather than by example because the
// failure it guards is exactly the case nobody enumerated.
// ═══════════════════════════════════════════════════════════════════════════
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { acceptedTypes, applyCell, NoCellError } from "./index";

// `acceptedTypes` and `applyCell` read `update` (+ the optional `__form` stamp)
// and nothing else, so a hand-shaped machine is the narrowest way to pin tables
// the mapped `Transitions`/`Reducer` types deliberately cannot express — a
// state with no cells, a state with no row at all, an untagged state.
const cell = () => (s: unknown) => [s, []] as const;

describe("acceptedTypes — transitions form", () => {
  const machine = {
    __form: "transitions" as const,
    update: {
      idle: { start: cell() },
      running: { step: cell(), halt: cell() },
      frozen: {},
    },
  };

  it("returns the refusing state's own row keys, not the table-wide union", () => {
    expect(acceptedTypes(machine, { type: "running" })).toEqual([
      "step",
      "halt",
    ]);
    expect(acceptedTypes(machine, { type: "idle" })).toEqual(["start"]);
  });

  it("a state with no cells returns an empty array, not undefined and not a throw", () => {
    const answer = acceptedTypes(machine, { type: "frozen" });
    expect(answer).toEqual([]);
    expect(Array.isArray(answer)).toBe(true);
  });

  it("a state with no row at all accepts nothing, which is true of it", () => {
    expect(acceptedTypes(machine, { type: "vanished" })).toEqual([]);
    // Untagged under the transitions form is the same fact: no row, no cells.
    expect(acceptedTypes(machine, { count: 1 })).toEqual([]);
  });

  it("a nullish state is read without a throw, and accepts nothing", () => {
    // The doc promises this function never throws; before #196 the row lookup
    // dereferenced `state.type` and a pre-boot `null` crashed the caller that
    // trusted it.
    expect(acceptedTypes(machine, undefined)).toEqual([]);
    expect(acceptedTypes(machine, null)).toEqual([]);
  });
});

describe("acceptedTypes — reducer form", () => {
  const machine = {
    __form: "reducer" as const,
    update: { bump: cell(), reset: cell() },
  };

  it("returns the flat table's keys", () => {
    expect(acceptedTypes(machine, { type: "counting", count: 3 })).toEqual([
      "bump",
      "reset",
    ]);
  });

  it("an untagged state is handled as the refusal path handles it — no throw", () => {
    // Dispatch in this form never consults the state, so the answer is
    // well-defined for a state carrying no discriminant at all. The refusal
    // path reaches the same set and only the state NAME degrades to a
    // placeholder; neither path throws on the untagged read.
    expect(acceptedTypes(machine, { count: 3 })).toEqual(["bump", "reset"]);
  });

  it("a nullish state is no state at all and accepts nothing", () => {
    // Untagged is a state whose shape carries no discriminant; nullish is the
    // absence of a state — a caller holding a pre-boot `null` is told nothing
    // is dispatchable rather than being handed the whole flat table (#196).
    expect(acceptedTypes(machine, undefined)).toEqual([]);
    expect(acceptedTypes(machine, null)).toEqual([]);
  });

  it("an empty update returns an empty array", () => {
    expect(
      acceptedTypes({ __form: "reducer", update: {} }, { type: "x" }),
    ).toEqual([]);
  });
});

describe("acceptedTypes agrees with the refusal — property (#21)", () => {
  const MSG_TYPES = ["a", "b", "c", "d"] as const;
  const STATE_TYPES = ["s1", "s2", "s3"] as const;

  /** A ragged transitions table: any subset of Msg types per state row. */
  const transitionsArb = fc
    .tuple(
      ...STATE_TYPES.map(() =>
        fc.subarray([...MSG_TYPES], { minLength: 0, maxLength: 4 }),
      ),
    )
    .map((rows) => ({
      __form: "transitions" as const,
      update: Object.fromEntries(
        STATE_TYPES.map((name, i) => [
          name,
          Object.fromEntries((rows[i] ?? []).map((k) => [k, cell()])),
        ]),
      ),
    }));

  const reducerArb = fc
    .subarray([...MSG_TYPES], { minLength: 0, maxLength: 4 })
    .map((keys) => ({
      __form: "reducer" as const,
      update: Object.fromEntries(keys.map((k) => [k, cell()])),
    }));

  /**
   * The two skins are one reading. For every `(machine, state, msgType)`:
   * a msg type the helper OMITS is refused by `applyCell`, and that refusal's
   * own `acceptedTypes` is exactly what the helper returned. A second,
   * drifting implementation of the accept-set reading fails this.
   */
  const agrees = (
    machine: { update: object; __form?: "reducer" | "transitions" },
    state: { type: string } | null | undefined,
    msgType: string,
  ) => {
    const asked = acceptedTypes(machine, state);
    let refusal: NoCellError | undefined;
    try {
      applyCell(machine, state, { type: msgType });
    } catch (err) {
      expect(err).toBeInstanceOf(NoCellError);
      refusal = err as NoCellError;
    }

    if (asked.includes(msgType)) {
      // Present in the set ⇒ a cell ran, so there is nothing to refuse.
      expect(refusal).toBeUndefined();
      return;
    }
    // Omitted from the set ⇒ `applyCell` MUST refuse, and must report the
    // same set the caller was told when it asked first.
    expect(refusal).toBeInstanceOf(NoCellError);
    expect(refusal?.acceptedTypes).toEqual(asked);
  };

  it("transitions form: omission implies refusal, and the refusal reports the same set", () => {
    fc.assert(
      fc.property(
        transitionsArb,
        fc.constantFrom(...STATE_TYPES, "unmapped"),
        fc.constantFrom(...MSG_TYPES, "unmapped"),
        (machine, stateType, msgType) =>
          agrees(machine, { type: stateType }, msgType),
      ),
    );
  });

  it("reducer form: omission implies refusal, and the refusal reports the same set", () => {
    fc.assert(
      fc.property(
        reducerArb,
        fc.constantFrom(...MSG_TYPES, "unmapped"),
        (machine, msgType) => agrees(machine, { type: "counting" }, msgType),
      ),
    );
  });

  // The mapped `Transitions`/`Reducer` types forbid a non-function cell, so
  // this case is reachable only through a cast — which is exactly how wire
  // data and a hand-shaped table reach the kernel. `lookupCell` admits a cell
  // on `typeof cell === "function"`, so a row value that is a string, a number
  // or `null` must be omitted from the accept-set too: reported as accepted it
  // would promise a dispatch the refusal path then refuses (#196).
  const notACell = fc.constantFrom<unknown>(
    "not a cell",
    0,
    null,
    { call: true },
    [],
  );

  /** A row value that is a cell about half the time and junk the rest. */
  const cellOrJunk = fc
    .oneof(fc.constant<unknown>(undefined), notACell)
    .map((junk) => (junk === undefined ? cell() : junk));

  const poisonedTransitionsArb = fc
    .tuple(
      ...STATE_TYPES.map(() =>
        fc.dictionary(fc.constantFrom(...MSG_TYPES), cellOrJunk),
      ),
    )
    .map((rows) => ({
      __form: "transitions" as const,
      update: Object.fromEntries(
        STATE_TYPES.map((name, i) => [name, rows[i] ?? {}]),
      ),
    }));

  const poisonedReducerArb = fc
    .dictionary(fc.constantFrom(...MSG_TYPES), cellOrJunk)
    .map((update) => ({ __form: "reducer" as const, update }));

  it("transitions form: a cast-in non-function cell is omitted, and the refusal agrees", () => {
    fc.assert(
      fc.property(
        poisonedTransitionsArb,
        fc.constantFrom(...STATE_TYPES, "unmapped"),
        fc.constantFrom(...MSG_TYPES, "unmapped"),
        (machine, stateType, msgType) =>
          agrees(machine, { type: stateType }, msgType),
      ),
    );
  });

  it("reducer form: a cast-in non-function cell is omitted, and the refusal agrees", () => {
    fc.assert(
      fc.property(
        poisonedReducerArb,
        fc.constantFrom(...MSG_TYPES, "unmapped"),
        (machine, msgType) => agrees(machine, { type: "counting" }, msgType),
      ),
    );
  });

  // The agreement is stated over the NULLISH state too (#199). It is the one
  // case where the two forms previously diverged in opposite directions:
  // transitions threw a `TypeError` off the row lookup, and reducer ran a cell
  // for a machine that had not booted while the helper answered `[]`. Both now
  // refuse, so `asked` being empty and `applyCell` refusing everything are the
  // same fact here as everywhere else.
  const nullishArb = fc.constantFrom<null | undefined>(null, undefined);

  it("transitions form: a nullish state refuses every Msg, and the refusal agrees", () => {
    fc.assert(
      fc.property(
        transitionsArb,
        nullishArb,
        fc.constantFrom(...MSG_TYPES, "unmapped"),
        (machine, state, msgType) => agrees(machine, state, msgType),
      ),
    );
  });

  it("reducer form: a nullish state refuses every Msg, and the refusal agrees", () => {
    fc.assert(
      fc.property(
        reducerArb,
        nullishArb,
        fc.constantFrom(...MSG_TYPES, "unmapped"),
        (machine, state, msgType) => agrees(machine, state, msgType),
      ),
    );
  });
});

describe("applyCell on a nullish state — NoCellError, never a TypeError (#199)", () => {
  const transitions = {
    __form: "transitions" as const,
    update: { idle: { start: cell() } },
  };
  const reducer = {
    __form: "reducer" as const,
    update: { bump: cell(), reset: cell() },
  };

  const refusalOf = (
    machine: { update: object; __form?: "reducer" | "transitions" },
    state: null | undefined,
    msgType: string,
  ) => {
    try {
      applyCell(machine, state, { type: msgType });
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it.each([
    ["transitions", transitions, "start"],
    ["reducer", reducer, "bump"],
  ] as const)("%s form: refuses a Msg the machine otherwise accepts", (_form, machine, msgType) => {
    for (const state of [null, undefined] as const) {
      const err = refusalOf(machine, state, msgType);
      expect(err).toBeInstanceOf(NoCellError);
      expect((err as NoCellError).acceptedTypes).toEqual([]);
      expect((err as NoCellError).stateName).toBe("(no state)");
    }
  });
});
