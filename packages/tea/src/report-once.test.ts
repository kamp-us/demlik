/**
 * A reducer's thrown object reaches the sink once, whichever way its Msg came in.
 *
 * Supervision reports the throw under `"reduce"` and rethrows it, so the step
 * rejects. A Msg with a caller hands that rejection to the caller. A Msg with
 * none (a `tell`, or a Msg a Cmd sends back) used to hand it to the sink a
 * second time, under `"follow-up"`.
 */

import { describe, expect, it } from "vitest";
import {
  defineMachine,
  type Interpret,
  type Reducer,
  type RuntimeErrorPhase,
} from "./index";
import { run, tell } from "./promise";

type State = { readonly n: number };
type Msg =
  | { readonly type: "boom" }
  | { readonly type: "kick" }
  | { readonly type: "inc" };
type Fire = { readonly type: "fire" };

const update: Reducer<State, Msg, Fire> = {
  boom: () => {
    throw new Error("reducer threw");
  },
  kick: (s) => [s, [{ type: "fire" }]],
  inc: (s) => [{ n: s.n + 1 }, []],
};
const machine = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Fire,
    ctx: undefined,
  },
  init: () => [{ n: 0 }, []],
  update,
});
const interpret: Interpret<Msg, Fire, undefined> = {
  fire: async () => ({ type: "boom" }),
};

/** A live run that keeps going after a throw, and the phases its sink heard. */
const open = async () => {
  const phases: RuntimeErrorPhase[] = [];
  const runtime = await run(machine, {
    ctx: undefined,
    interpret,
    supervision: "escalate",
    onError: (_error, context) => phases.push(context.phase),
  }).ready;
  return { runtime, phases };
};

describe("a reducer throw reaches the sink once", () => {
  it("through `tell`", async () => {
    const { runtime, phases } = await open();
    expect(tell(machine, runtime, { type: "boom" })).toBe("queued");
    await runtime.idle();
    expect(phases).toEqual(["reduce"]);
  });

  it("through a Msg a Cmd sends back", async () => {
    const { runtime, phases } = await open();
    await runtime.dispatch({ type: "kick" });
    await runtime.idle();
    expect(phases).toEqual(["reduce"]);
  });

  it("through `dispatch`, whose caller also gets the throw", async () => {
    const { runtime, phases } = await open();
    await expect(runtime.dispatch({ type: "boom" })).rejects.toThrow(
      "reducer threw",
    );
    expect(phases).toEqual(["reduce"]);
  });

  it("and the run folds on after it", async () => {
    const { runtime } = await open();
    tell(machine, runtime, { type: "boom" });
    tell(machine, runtime, { type: "inc" });
    await runtime.idle();
    expect(runtime.getState()).toEqual({ n: 1 });
  });
});

describe("failed boot refusals stay visible", () => {
  it.each([
    false,
    true,
  ])("reports each later tell when boot's error was already reported: %s", async (alreadyReported) => {
    const failure = new Error("boot handler failed");
    const reports: {
      readonly error: unknown;
      readonly phase: RuntimeErrorPhase;
    }[] = [];
    const bootMachine = defineMachine({
      ...machine,
      init: () => [{ n: 0 }, [{ type: "fire" }]],
    });
    const booting = run(bootMachine, {
      ctx: undefined,
      interpret: {
        fire: () => {
          throw failure;
        },
      },
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    });
    if (alreadyReported) {
      booting.onBoot(() => {
        throw failure;
      });
    }

    await expect(booting.ready).rejects.toBe(failure);
    const expected = alreadyReported ? [{ error: failure, phase: "boot" }] : [];
    expect(reports).toEqual(expected);

    for (const _ of ["first", "second", "third"]) {
      // @ts-expect-error failed boot exposes no ready handle; exercise a caller bypassing the type.
      expect(tell(bootMachine, booting, { type: "inc" })).toBe("queued");
      await expect(booting.dispatch({ type: "inc" })).rejects.toBe(failure);
      expected.push({ error: failure, phase: "follow-up" });
      expect(reports).toEqual(expected);
    }
    await booting.stop();
  });
});

describe("known limit: primitive reducer throws are reported twice", () => {
  it.each(["tell", "Cmd reply"] as const)("through %s", async (source) => {
    const primitiveMachine = defineMachine({
      ...machine,
      update: {
        ...update,
        boom: () => {
          throw "x";
        },
      },
    });
    const reports: {
      readonly error: unknown;
      readonly phase: RuntimeErrorPhase;
    }[] = [];
    const runtime = await run(primitiveMachine, {
      ctx: undefined,
      interpret,
      supervision: "escalate",
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;

    if (source === "tell") {
      expect(tell(primitiveMachine, runtime, { type: "boom" })).toBe("queued");
    } else {
      await runtime.dispatch({ type: "kick" });
    }
    await runtime.idle();
    expect(reports).toEqual([
      { error: "x", phase: "reduce" },
      { error: "x", phase: "follow-up" },
    ]);
    await runtime.stop();
  });
});
