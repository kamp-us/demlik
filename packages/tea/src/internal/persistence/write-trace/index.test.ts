import { describe, expect, it } from "vitest";
import type { SaveBoundary } from "../../../runtime-types";
import type { Trace } from "../recorder";
import { writeTrace } from "./index";

interface Msg {
  readonly _tag: "inc";
  readonly by: number;
}

type Call =
  | { readonly kind: "load" }
  | {
      readonly kind: "save";
      readonly state: number;
      readonly msg: unknown;
      readonly boundary: SaveBoundary | undefined;
    };

/** A store that only remembers what it was asked, in order. */
function remembering() {
  const calls: Call[] = [];
  return {
    calls,
    store: {
      load: async () => {
        calls.push({ kind: "load" });
        return null;
      },
      save: async (state: number, msg?: unknown, boundary?: SaveBoundary) => {
        calls.push({ kind: "save", state, msg, boundary });
      },
    },
  };
}

const inc = (by: number): Msg => ({ _tag: "inc", by });
const trace = (over: Partial<Trace<number, Msg>>): Trace<number, Msg> => ({
  loaded: 0,
  msgs: [],
  finalState: 0,
  ...over,
});

describe("writeTrace", () => {
  it("loads, saves the init boundary for the loaded State, then each recorded step", async () => {
    const { calls, store } = remembering();

    await writeTrace(
      store,
      trace({
        msgs: [inc(1), inc(2)],
        finalState: 3,
        steps: [
          { msg: inc(1), state: 1, cmds: [{ _tag: "notify" }] },
          { msg: inc(2), state: 3, cmds: [] },
        ],
      }),
    );

    expect(calls).toEqual([
      { kind: "load" },
      {
        kind: "save",
        state: 0,
        msg: undefined,
        boundary: { _tag: "init", cmds: [] },
      },
      {
        kind: "save",
        state: 1,
        msg: inc(1),
        boundary: { _tag: "step", cmds: [{ _tag: "notify" }] },
      },
      {
        kind: "save",
        state: 3,
        msg: inc(2),
        boundary: { _tag: "step", cmds: [] },
      },
    ]);
  });

  it("writes a step recorded without Cmds with no boundary", async () => {
    const { calls, store } = remembering();

    await writeTrace(
      store,
      trace({
        msgs: [inc(1)],
        finalState: 1,
        steps: [{ msg: inc(1), state: 1 }],
      }),
    );

    expect(calls.at(-1)).toMatchObject({ state: 1, boundary: undefined });
  });

  it("writes only the init boundary for a trace that saw no Msg", async () => {
    const { calls, store } = remembering();

    await writeTrace(store, trace({}));

    expect(calls.map((call) => call.kind)).toEqual(["load", "save"]);
  });

  it.each([
    ["has no post-init State", trace({ loaded: null }), /no post-init State/],
    [
      "holds Msgs but kept no steps",
      trace({ msgs: [inc(1)], finalState: 1 }),
      /kept no steps/,
    ],
    [
      "has fewer steps than Msgs",
      trace({
        msgs: [inc(1), inc(2)],
        finalState: 3,
        steps: [{ msg: inc(1), state: 1 }],
      }),
      /1 steps for 2 messages/,
    ],
    [
      "has more steps than Msgs",
      trace({
        msgs: [inc(1)],
        finalState: 3,
        steps: [
          { msg: inc(1), state: 1 },
          { msg: inc(2), state: 3 },
        ],
      }),
      /2 steps for 1 messages/,
    ],
  ])("refuses a trace that %s, before it loads or saves", async (_name, bad, message) => {
    const { calls, store } = remembering();

    await expect(writeTrace(store, bad)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });
});
