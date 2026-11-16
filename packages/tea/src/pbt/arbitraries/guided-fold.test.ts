import { describe, expect, it } from "vitest";
import { defineMachine } from "../../index";
import { type Answerer, type BlindEvent, resolveGuided } from "./guided-fold";

// `ping` sends one `ask`; `asked` answers it. The state counts, never keeps a Cmd.
type Ask = { readonly _tag: "ask"; readonly n: number };
type Msg =
  | { readonly _tag: "ping" }
  | { readonly _tag: "asked"; readonly cmd: Ask; readonly value: unknown };

const machine = defineMachine({
  types: {
    model: {} as number,
    msg: {} as Msg,
    cmd: {} as Ask,
    ctx: {} as object,
  },
  init: (loaded) => [loaded ?? 0, []],
  update: {
    ping: (n) => [n + 1, [{ _tag: "ask", n }]],
    asked: (n) => [n, []],
  },
});

const answerers: readonly Answerer<Ask, Msg>[] = [
  { cmdType: "ask", make: (cmd, value) => ({ _tag: "asked", cmd, value }) },
];
const ping = { _tag: "ping" } as const;
const answer = (otherwise?: Msg): BlindEvent<Msg> =>
  otherwise === undefined
    ? { kind: "answer", pick: 0, values: ["v"] }
    : { kind: "answer", pick: 0, values: ["v"], otherwise };
const resolve = (events: readonly BlindEvent<Msg>[]) =>
  resolveGuided(machine, {}, null, answerers, events).map((m) => m._tag);

describe("resolveGuided", () => {
  it("drops an answer with nothing waiting", () => {
    expect(
      resolve([answer(), { kind: "outside", msg: ping }, answer()]),
    ).toEqual(["ping", "asked"]);
  });

  it("puts an answer's otherwise Msg in its place when nothing is waiting", () => {
    expect(resolve([answer(ping), answer(ping), answer(ping)])).toEqual([
      "ping",
      "asked",
      "ping",
    ]);
  });

  it("answers each sent Cmd once", () => {
    expect(
      resolve([{ kind: "outside", msg: ping }, answer(), answer()]),
    ).toEqual(["ping", "asked"]);
  });
});
