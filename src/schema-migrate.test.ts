import { describe, expect, it } from "vitest";
import {
  defineMachine,
  type Interpret,
  type Reducer,
  run,
  type Schema,
  type Store,
  schemaMigrate,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// `schemaMigrate` splits `Store.migrate` into its two real jobs: structural
// validation (derivable from the State type, so derive it) and version
// migration (genuine logic, so keep it explicit and thin). The contract the
// substrate depends on is that it NEVER throws — an unrecognized shape returns
// `null`, which is the fresh-boot path. A throwing migrate would collapse
// "storage corruption" and "migration not written yet" into one panic.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly count: number; readonly label: string };

// A minimal Standard-Schema-shaped validator — the same `safeParse` surface
// zod 3 and zod 4 satisfy. No validator library is imported by the kernel.
const stateSchema: Schema<State> = {
  safeParse(raw) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { count?: unknown }).count === "number" &&
      typeof (raw as { label?: unknown }).label === "string"
    ) {
      return { success: true, data: raw as State };
    }
    return { success: false };
  },
};

describe("schemaMigrate — structural validation (job 1)", () => {
  it("returns the parsed State for a recognized shape", () => {
    const migrate = schemaMigrate(stateSchema);
    expect(migrate({ count: 3, label: "hi" })).toEqual({
      count: 3,
      label: "hi",
    });
  });

  it("returns null — never throws — for an unrecognized shape", () => {
    const migrate = schemaMigrate(stateSchema);
    expect(migrate({ count: "three" })).toBeNull();
    expect(migrate(null)).toBeNull();
    expect(migrate(undefined)).toBeNull();
    expect(migrate("garbage")).toBeNull();
  });
});

describe("schemaMigrate — version migration (job 2)", () => {
  it("runs `upcast` BEFORE the parse, so an old shape can be brought forward", () => {
    // v0 rows had no `label`; the upcast defaults it, then the schema validates.
    const migrate = schemaMigrate(stateSchema, (raw) => ({
      label: "legacy",
      ...(raw as object),
    }));
    expect(migrate({ count: 7 })).toEqual({ count: 7, label: "legacy" });
  });

  it("defaults `upcast` to identity when no version migration exists yet", () => {
    const migrate = schemaMigrate(stateSchema);
    expect(migrate({ count: 1, label: "a" })).toEqual({ count: 1, label: "a" });
  });

  it("collapses a THROWING upcast to null rather than panicking the boot", () => {
    const migrate = schemaMigrate(stateSchema, () => {
      throw new Error("corrupt blob");
    });
    expect(() => migrate({ count: 1, label: "a" })).not.toThrow();
    expect(migrate({ count: 1, label: "a" })).toBeNull();
  });

  it("still returns null when the upcast produces a shape the schema rejects", () => {
    const migrate = schemaMigrate(stateSchema, () => ({ nope: true }));
    expect(migrate({ count: 1, label: "a" })).toBeNull();
  });
});

describe("schemaMigrate — wired as a real Store.migrate", () => {
  type Msg = { readonly type: "bump" };
  const update: Reducer<State, Msg, never> = {
    bump: (s) => [{ ...s, count: s.count + 1 }, []],
  };
  const machine = defineMachine<State, Msg, never, never, undefined>({
    init: (loaded) => [loaded ?? { count: 0, label: "fresh" }, []],
    update,
    interpret: {} as Interpret<Msg, never, undefined>,
  });

  function storeOf(raw: unknown): Store<State> {
    return {
      load: async () => raw,
      save: async () => {},
      migrate: schemaMigrate(stateSchema),
    };
  }

  it("rehydrates a recognized blob", async () => {
    const rt = await run(machine, {
      ctx: undefined,
      store: storeOf({ count: 5, label: "saved" }),
    }).ready;
    expect(rt.getState()).toEqual({ count: 5, label: "saved" });
  });

  it("boots fresh from an unrecognized blob instead of failing the boot", async () => {
    const rt = await run(machine, {
      ctx: undefined,
      store: storeOf({ totally: "wrong" }),
    }).ready;
    expect(rt.getState()).toEqual({ count: 0, label: "fresh" });
  });
});
