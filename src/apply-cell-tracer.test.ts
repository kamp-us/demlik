import { describe, expect, it } from "vitest";
import {
  defineMachine,
  detectUpdateForm,
  foldMsgs,
  formOf,
  type Interpret,
  type Machine,
  replay,
  run,
  type Transitions,
} from "./index";
import { toMermaid } from "./machine-viz";
import { foldEvents, msgTypeKeys } from "./pbt";
import { withDeadline } from "./with-deadline";
import { withResilience } from "./with-resilience";
import { withTelemetry } from "./with-telemetry";

// ───────────────────────────────────────────────────────────────────────────
// Vertical tracer (#275): ONE machine, the exact shape `__form` disambiguates,
// stepped/classified by EVERY dispatch consumer — production `run`, the pure
// folds, the PBT fold runner, machine-viz, msg-keys, and the withX wrappers —
// asserting they all agree. Pre-#275 the verification tools re-derived the
// update form with a local structural heuristic frozen at the pre-`__form`
// snapshot, so they could disagree with production on this machine; every
// consumer now dispatches through the single `applyCell` primitive keyed on
// `formOf`.
// ───────────────────────────────────────────────────────────────────────────

type LState = { readonly type: "red" } | { readonly type: "green" };
type LMsg = { readonly type: "go" } | { readonly type: "stop" };
type LCmd = { readonly type: "ping" };

// The __form-disambiguated shape: a Transitions table whose FIRST inner record
// is a callable object — a function carrying the msg cells as own-enumerable
// keys. The structural heuristic (`typeof firstValue === "function"` ⇒
// Reducer) misreads this table as Reducer form; only the authoritative
// `__form` tag classifies it correctly.
function disambiguatedMachine(): Machine<LState, LMsg, LCmd, never, undefined> {
  const red = Object.assign(
    () => {
      throw new Error("the callable carrier is never invoked as a cell");
    },
    {
      go: (_s: LState, _m: LMsg) =>
        [{ type: "green" }, []] as readonly [LState, readonly LCmd[]],
      stop: (s: LState, _m: LMsg) =>
        [s, []] as readonly [LState, readonly LCmd[]],
    },
  );
  const update = {
    red,
    green: {
      go: (s: LState, _m: LMsg) =>
        [s, []] as readonly [LState, readonly LCmd[]],
      stop: (_s: LState, _m: LMsg) =>
        [{ type: "red" }, []] as readonly [LState, readonly LCmd[]],
    },
  } as unknown as Transitions<LState, LMsg, LCmd>;
  const def: Machine<LState, LMsg, LCmd, never, undefined> = {
    init: () => [{ type: "red" }, []],
    update,
    // A real `ping` handler key: withResilience refuses a target Cmd with no
    // base interpret handler (#112). Never invoked — no cell emits `ping`.
    interpret: { ping: async () => undefined } as unknown as Interpret<
      LMsg,
      LCmd,
      undefined
    >,
  };
  // Stamp the correct form the way the typed construction boundary would.
  // Hand-stamped here because `defineMachine`'s runtime fallback IS the
  // structural heuristic this machine defeats; `defineMachine` honors a
  // pre-existing tag (its idempotence branch), so this models a machine whose
  // form was fixed at construction.
  Object.defineProperty(def, "__form", {
    value: "transitions",
    enumerable: false,
  });
  return defineMachine(def);
}

const GO: LMsg = { type: "go" };

describe("applyCell vertical tracer — every consumer agrees on the __form-disambiguated machine (#275)", () => {
  it("the machine IS disambiguated: __form contradicts the structural heuristic", () => {
    const m = disambiguatedMachine();
    expect(formOf(m)).toBe("transitions");
    expect(detectUpdateForm(m.update as object)).toBe("reducer");
  });

  it("production run steps red --go--> green", async () => {
    const rt = await run(disambiguatedMachine(), { ctx: undefined }).ready;
    await rt.dispatch(GO);
    expect(rt.getState()).toEqual({ type: "green" });
  });

  it("the pure folds (foldMsgs, replay) agree", () => {
    const m = disambiguatedMachine();
    expect(foldMsgs(m, { type: "red" }, [GO])).toEqual({ type: "green" });
    const { state } = replay(m, { msgs: [GO], ctx: undefined });
    expect(state).toEqual({ type: "green" });
  });

  it("the PBT fold runner (foldEvents) agrees", () => {
    const { finalState } = foldEvents(disambiguatedMachine(), undefined, null, [
      GO,
    ]);
    expect(finalState).toEqual({ type: "green" });
  });

  it("machine-viz classifies it as Transitions form", () => {
    const out = toMermaid(disambiguatedMachine());
    expect(out).toContain("Transitions-form machine.");
    expect(out).not.toContain("Reducer-form machine");
  });

  it("msgTypeKeys reads the Msg set, not the state set", () => {
    expect([...msgTypeKeys(disambiguatedMachine())].sort()).toEqual([
      "go",
      "stop",
    ]);
  });

  it("withTelemetry steps the base identically", () => {
    const wrapped = withTelemetry(disambiguatedMachine());
    const { state } = replay(wrapped, {
      msgs: [GO],
      ctx: undefined as never,
    });
    expect(state.base).toEqual({ type: "green" });
  });

  it("withDeadline steps the base identically", () => {
    const wrapped = withDeadline(disambiguatedMachine(), { ms: 1000 });
    const { state } = replay(wrapped, { msgs: [GO], ctx: undefined });
    expect(state.base).toEqual({ type: "green" });
  });

  it("withResilience steps the base identically", () => {
    const wrapped = withResilience(disambiguatedMachine(), { target: "ping" });
    const { state } = replay(wrapped, {
      msgs: [GO],
      ctx: undefined as never,
    });
    expect(state.base).toEqual({ type: "green" });
  });
});
