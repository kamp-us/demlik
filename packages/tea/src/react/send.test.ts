/**
 * `senderOf`: one `send` per handle, which waits for nothing, and each failure
 * heard once, by the run's sink or by `report`, never both.
 */

import { describe, expect, it } from "vitest";
import {
  DispatchDiscardedError,
  defineMachine,
  NoCellError,
  type RuntimeErrorPhase,
} from "../index";
import { run } from "../promise";
import { senderOf } from "./send";

type Msg = { readonly type: "inc" } | { readonly type: "boom" };
const machine = defineMachine({
  types: { model: {} as { n: number }, msg: {} as Msg, ctx: undefined },
  init: () => [{ n: 0 }, []],
  update: {
    inc: (s) => [{ n: s.n + 1 }, []],
    boom: () => {
      throw new Error("reducer threw");
    },
  },
});

type Heard = { readonly phase: RuntimeErrorPhase; readonly error: unknown };
const open = async () => {
  const sink: Heard[] = [];
  const reported: Heard[] = [];
  const runtime = await run(machine, {
    ctx: undefined,
    supervision: "escalate",
    onError: (error, { phase }) => sink.push({ phase, error }),
  }).ready;
  const send = senderOf(runtime, (error, { phase }) =>
    reported.push({ phase, error }),
  );
  return { runtime, send, sink, reported };
};

describe("senderOf on a run from `run`", () => {
  it("returns nothing and the Msg folds", async () => {
    const { runtime, send } = await open();
    expect(send({ type: "inc" })).toBeUndefined();
    await runtime.idle();
    expect(runtime.getState()).toEqual({ n: 1 });
  });

  it("a reducer throw: the run's sink hears it once, `report` never", async () => {
    const { runtime, send, sink, reported } = await open();
    send({ type: "boom" });
    await runtime.idle();
    expect(sink.map((h) => h.phase)).toEqual(["reduce"]);
    expect(reported).toEqual([]);
  });

  it("a Msg with no cell stays loud: the run's sink hears its NoCellError", async () => {
    const { runtime, send, sink } = await open();
    send({ type: "nope" } as unknown as Msg);
    await runtime.idle();
    expect(sink).toHaveLength(1);
    expect(sink[0]?.error).toBeInstanceOf(NoCellError);
  });

  it("a send to a stopped run: `report` hears a discard", async () => {
    const { runtime, send, sink, reported } = await open();
    await runtime.stop();
    send({ type: "inc" });
    expect(reported.map((h) => h.phase)).toEqual(["discard"]);
    expect(reported[0]?.error).toBeInstanceOf(DispatchDiscardedError);
    expect(sink).toEqual([]);
  });
});

describe("senderOf on a hand-built handle", () => {
  it("`report` hears what its `dispatch` rejects with", async () => {
    const reported: RuntimeErrorPhase[] = [];
    const send = senderOf<{ n: number }, Msg>(
      { dispatch: () => Promise.reject(new Error("no")) },
      (_error, { phase }) => reported.push(phase),
    );
    send({ type: "inc" });
    await Promise.resolve();
    await Promise.resolve();
    expect(reported).toEqual(["follow-up"]);
  });
});
