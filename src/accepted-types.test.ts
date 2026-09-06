import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { acceptedTypes, applyCell, NoCellError } from "./index";
// `acceptedTypes` ships under the same two subpaths its introspection siblings
// do (`.` above, `./pure` here). The kernel introspection surface is the tier
// that carries it; pinning both keeps a future re-tier from dropping one.
import { acceptedTypes as acceptedTypesFromPure } from "./pure";

// ───────────────────────────────────────────────────────────────────────────
// #21 — `acceptedTypes(machine, state)`: ask which Msgs a state admits BEFORE
// dispatching, instead of learning it by refusal.
//
// The runtime companion to `NoCellError.acceptedTypes` (#14). It is a second
// thin skin over the ONE `lookupCell` selection the throwing (`applyCell`) and
// `Result` (`tryApplyCell`) paths already share — not a parallel walk of the
// update table that could become a third opinion about which cells exist. The
// property at the bottom is what ties the skins to the one selection.
// ───────────────────────────────────────────────────────────────────────────

// `acceptedTypes` reads only `update` (+ the optional `__form` stamp), so a
// hand-shaped machine is the narrowest way to pin tables the mapped `Transitions`
// type deliberately cannot express — a state with no cells, a rogue state.type.
const cell = (s: unknown) => [s, []] as const;

describe("acceptedTypes — transitions form", () => {
  const m = {
    __form: "transitions" as const,
    update: {
      idle: { start: cell },
      running: { step: cell, halt: cell },
      frozen: {},
    },
  };

  it("returns the state's own per-state cell keys", () => {
    expect(acceptedTypes(m, { type: "running" })).toEqual(["step", "halt"]);
    expect(acceptedTypes(m, { type: "idle" })).toEqual(["start"]);
  });

  it("a state with no cells returns an empty array, not undefined and not a throw", () => {
    expect(acceptedTypes(m, { type: "frozen" })).toEqual([]);
  });

  it("a type-bypassed missing ROW (unknown state.type) accepts nothing", () => {
    expect(acceptedTypes(m, { type: "vanished" })).toEqual([]);
  });
});

describe("acceptedTypes — reducer form", () => {
  const m = {
    __form: "reducer" as const,
    update: { bump: cell, reset: cell },
  };

  it("returns the flat table's keys — dispatch never consults the state", () => {
    expect(acceptedTypes(m, { type: "counting", count: 3 })).toEqual([
      "bump",
      "reset",
    ]);
  });

  it("an untagged state is handled the same way the refusal path handles it — the flat keys, no throw", () => {
    // The reducer refusal path reads a placeholder state name but the accepted
    // set is the table's keys regardless; `acceptedTypes` never reaches the
    // state read, so an untagged state is no special case here.
    expect(acceptedTypes(m, { count: 3 })).toEqual(["bump", "reset"]);
    expect(acceptedTypes(m, undefined)).toEqual(["bump", "reset"]);
  });

  it("an empty update accepts nothing", () => {
    expect(
      acceptedTypes({ __form: "reducer" as const, update: {} }, {}),
    ).toEqual([]);
  });
});

describe("acceptedTypes — exported from the pure subpath too", () => {
  it("is the same function under `@demlik/tea/pure`", () => {
    expect(acceptedTypesFromPure).toBe(acceptedTypes);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The tie between the two skins (acceptance criterion). For ANY machine, state
// and msg: if `acceptedTypes` omits the msg.type then `applyCell` refuses it,
// and the refusal's own `acceptedTypes` equals what the helper returned. This
// is the test that catches the helper and the throw path drifting apart.
// ───────────────────────────────────────────────────────────────────────────

describe("acceptedTypes — the two skins agree with the one selection (#21)", () => {
  // An arbitrary transitions table: state names → (msg names → cell). The
  // probed state and msg range over the declared names PLUS names that are not
  // in the table, so both the hit and the miss arms are exercised.
  const name = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);
  const transitionsMachine = fc
    .dictionary(name, fc.uniqueArray(name), { minKeys: 0, maxKeys: 4 })
    .map((rows) => {
      const update: Record<string, Record<string, typeof cell>> = {};
      for (const [state, msgs] of Object.entries(rows)) {
        update[state] = Object.fromEntries(msgs.map((t) => [t, cell]));
      }
      return { __form: "transitions" as const, update };
    });
  const reducerMachine = fc.uniqueArray(name).map((msgs) => ({
    __form: "reducer" as const,
    update: Object.fromEntries(msgs.map((t) => [t, cell])),
  }));

  const asserts = (
    m: { __form: "transitions" | "reducer"; update: object },
    stateType: string,
    msgType: string,
  ) => {
    const accepted = acceptedTypes(m, { type: stateType });
    if (accepted.includes(msgType)) return; // hit — not the arm under test
    try {
      applyCell(m, { type: stateType }, { type: msgType });
      throw new Error(
        `applyCell resolved — expected NoCellError for ${msgType}`,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(NoCellError);
      expect((err as NoCellError).acceptedTypes).toEqual(accepted);
    }
  };

  it("transitions form: a missing type is refused, and the refusal names the same set", () => {
    fc.assert(
      fc.property(transitionsMachine, name, name, (m, stateType, msgType) =>
        asserts(m, stateType, msgType),
      ),
    );
  });

  it("reducer form: a missing type is refused, and the refusal names the same set", () => {
    fc.assert(
      fc.property(reducerMachine, name, name, (m, stateType, msgType) =>
        asserts(m, stateType, msgType),
      ),
    );
  });
});
