import { describe, expect, it } from "vitest";
import {
  applyCell,
  defineMachine,
  NoCellError,
  type Reducer,
  Refusal,
  type Schema,
  type Store,
  StoreRefusedError,
  schemaMigrate,
} from "./index";
import { run } from "./promise";

// ───────────────────────────────────────────────────────────────────────────
// `schemaMigrate` splits `Store.migrate` into its two real jobs: structural
// validation (derivable from the State type, so derive it) and version
// migration (genuine logic, so keep it explicit and thin). It NEVER throws:
// nothing saved returns `null`, the fresh-boot path, and saved bytes it cannot
// read return a refusal, so `run` fails instead of booting fresh over them
// (#316).
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

  it("returns null when nothing was saved", () => {
    const migrate = schemaMigrate(stateSchema);
    expect(migrate(null)).toBeNull();
    expect(migrate(undefined)).toBeNull();
  });

  it("refuses — never throws — saved bytes of an unrecognized shape", () => {
    const migrate = schemaMigrate(stateSchema);
    expect(migrate({ count: "three" })).toBeInstanceOf(Refusal);
    expect(migrate("garbage")).toBeInstanceOf(Refusal);
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

  it("turns a THROWING upcast into a refusal carrying its message", () => {
    const migrate = schemaMigrate(stateSchema, () => {
      throw new Error("corrupt blob");
    });
    expect(() => migrate({ count: 1, label: "a" })).not.toThrow();
    const answer = migrate({ count: 1, label: "a" });
    expect(answer).toBeInstanceOf(Refusal);
    expect((answer as Refusal).reason).toContain("corrupt blob");
  });

  it("refuses when the upcast produces a shape the schema rejects", () => {
    const migrate = schemaMigrate(stateSchema, () => ({ nope: true }));
    expect(migrate({ count: 1, label: "a" })).toBeInstanceOf(Refusal);
  });
});

describe("schemaMigrate — wired as a real Store.migrate", () => {
  type Msg = { readonly _tag: "bump" };
  const update: Reducer<State, Msg, never> = {
    bump: (s) => [{ ...s, count: s.count + 1 }, []],
  };
  const machine = defineMachine({
    types: { model: {} as State, msg: {} as Msg, ctx: undefined },
    init: (loaded) => [loaded ?? { count: 0, label: "fresh" }, []],
    update,
  });

  function storeOf(raw: unknown): Store<State> & { saves: number } {
    const store = {
      saves: 0,
      load: async () => raw,
      save: async () => {
        store.saves += 1;
      },
      migrate: schemaMigrate(stateSchema),
    };
    return store;
  }

  it("rehydrates a recognized blob", async () => {
    const rt = await run(machine, {
      ctx: undefined,
      store: storeOf({ count: 5, label: "saved" }),
    }).ready;
    expect(rt.getState()).toEqual({ count: 5, label: "saved" });
  });

  it("boots fresh when nothing was saved", async () => {
    const rt = await run(machine, { ctx: undefined, store: storeOf(null) })
      .ready;
    expect(rt.getState()).toEqual({ count: 0, label: "fresh" });
  });

  it("refuses an unrecognized blob instead of booting fresh over it", async () => {
    const store = storeOf({ totally: "wrong" });
    await expect(run(machine, { ctx: undefined, store }).ready).rejects.toThrow(
      StoreRefusedError,
    );
    expect(store.saves).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A State saved by a release that keyed the discriminant `type` (before ADR
// 0037). tea converts nothing: these pin what each kind of `migrate` does with
// such a save, and that a one-line `upcast` is enough to keep it.
// ───────────────────────────────────────────────────────────────────────────

describe("a State saved before the discriminant was keyed `_tag`", () => {
  type Light =
    | { readonly _tag: "red"; readonly waited: number }
    | { readonly _tag: "green"; readonly waited: number };
  type LightMsg = { readonly _tag: "tick" };

  const lightSchema: Schema<Light> = {
    safeParse(raw) {
      const r = raw as { _tag?: unknown; waited?: unknown } | null;
      return typeof r === "object" &&
        r !== null &&
        (r._tag === "red" || r._tag === "green") &&
        typeof r.waited === "number"
        ? { success: true, data: raw as Light }
        : { success: false };
    },
  };

  const light = defineMachine({
    types: { model: {} as Light, msg: {} as LightMsg, ctx: undefined },
    init: (loaded) => [loaded ?? { _tag: "red", waited: 0 }, []],
    update: {
      red: { tick: (s, _m) => [{ _tag: "green", waited: s.waited + 1 }, []] },
      green: { tick: (s, _m) => [{ _tag: "red", waited: s.waited + 1 }, []] },
    },
  });

  const oldSave = { type: "green", waited: 7 };

  it("a schema-checked migrate refuses it", () => {
    expect(schemaMigrate(lightSchema)(oldSave)).toBeInstanceOf(Refusal);
  });

  it("an upcast that renames the key keeps it", () => {
    const migrate = schemaMigrate(lightSchema, (raw) => {
      const { type, ...rest } = raw as { type?: unknown };
      return type === undefined ? raw : { _tag: type, ...rest };
    });
    expect(migrate(oldSave)).toEqual({ _tag: "green", waited: 7 });
    // A save already written with `_tag` passes through the same upcast.
    expect(migrate({ _tag: "red", waited: 2 })).toEqual({
      _tag: "red",
      waited: 2,
    });
  });

  it("a migrate that does not check the shape hands the machine a State with no row", () => {
    const unchecked = oldSave as unknown as Light;
    expect(() => applyCell(light, unchecked, { _tag: "tick" })).toThrowError(
      NoCellError,
    );
  });
});
