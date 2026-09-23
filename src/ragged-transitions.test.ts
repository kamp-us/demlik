// #203 — a missing transitions cell is a DECLARED REFUSAL.
//
// The runtime half of this has been true since #20/#195: `lookupCell` misses,
// `applyCell` throws `NoCellError` naming `acceptedTypes`, `tryApplyCell`
// returns it as data. What #203 changed is that a table with holes in it can
// now be AUTHORED — `Transitions` cells are optional — so this file exercises
// the refusal through a machine built by `defineMachine`, not through a cast.
//
// The property that every omission implies a refusal reporting the same set
// lives in `accepted-types.test.ts`; this pins the end of that property an
// author can actually write.

import { describe, expect, it } from "vitest";
import {
  acceptedTypes,
  applyCell,
  defineMachine,
  NoCellError,
  tryApplyCell,
} from "./index";

type State =
  | { readonly type: "idle" }
  | { readonly type: "brewing"; readonly ms: number }
  | { readonly type: "done"; readonly cups: number };

type Msg =
  | { readonly type: "insert_coin" }
  | { readonly type: "brew" }
  | { readonly type: "tick" }
  | { readonly type: "collect" };

// 3 states × 4 messages is 12 cells if every one must exist. This machine
// declares 4, and `done` declares a row with one cell in it.
const machine = defineMachine<State, Msg, never, never, unknown>({
  init: (loaded) => [loaded ?? { type: "idle" }, []],
  update: {
    idle: {
      insert_coin: () => [{ type: "brewing", ms: 0 }, []],
    },
    brewing: {
      tick: (s) =>
        s.ms >= 200
          ? [{ type: "done", cups: 1 }, []]
          : [{ type: "brewing", ms: s.ms + 100 }, []],
      brew: (s) => [s, []],
    },
    done: {
      collect: () => [{ type: "idle" }, []],
    },
  },
  interpret: {},
});

describe("ragged transitions table (#203)", () => {
  it("acceptedTypes is the declared keys of that state — not every Msg type", () => {
    expect(acceptedTypes(machine, { type: "idle" })).toEqual(["insert_coin"]);
    expect(acceptedTypes(machine, { type: "brewing", ms: 0 })).toEqual([
      "tick",
      "brew",
    ]);
    expect(acceptedTypes(machine, { type: "done", cups: 1 })).toEqual([
      "collect",
    ]);
  });

  it("the declared cells still run", () => {
    expect(
      applyCell(machine, { type: "idle" }, { type: "insert_coin" }),
    ).toEqual([{ type: "brewing", ms: 0 }, []]);
  });

  it("a message with no cell in this state raises NoCellError naming the set", () => {
    let raised: NoCellError | undefined;
    try {
      applyCell(machine, { type: "idle" }, { type: "collect" });
    } catch (err) {
      raised = err as NoCellError;
    }
    expect(raised).toBeInstanceOf(NoCellError);
    expect(raised?.msgType).toBe("collect");
    expect(raised?.stateName).toBe("idle");
    // The refusal's set and the asked set are one reading, on a ragged row too.
    expect(raised?.acceptedTypes).toEqual(
      acceptedTypes(machine, { type: "idle" }),
    );
    expect(raised?.acceptedTypes).toEqual(["insert_coin"]);
  });

  it("the refusal is loud, never a silent absorb — the state does not advance", () => {
    const refusal = tryApplyCell(
      machine,
      { type: "done", cups: 1 },
      { type: "tick" },
    );
    expect(refusal._tag).toBe("Err");
    if (refusal._tag !== "Err") return;
    expect(refusal.error).toBeInstanceOf(NoCellError);
    expect(refusal.error.acceptedTypes).toEqual(["collect"]);
  });
});
