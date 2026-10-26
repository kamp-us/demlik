import { createInterface } from "node:readline";
import { z } from "zod";
import {
  defineMachine,
  foldMsgs,
  NoCellError,
  type Transitions,
} from "../../packages/tea/src/index.ts";
import { foldUpdates } from "../../packages/tea/src/pure/core.ts";
import { actorInput, executeActor } from "./typed-reducer-actor-reference.mts";

const pure = z
  .object({
    suite: z.literal("pure"),
    verb: z.enum(["updates", "updates-shared", "msgs", "msgs-shared"]),
    scenario: z.enum([
      "empty",
      "ordered",
      "reject-first",
      "reject-middle",
      "missing-first",
      "missing-middle",
      "nested-no-cell",
      "panic",
    ]),
  })
  .strict();
const request = z
  .object({
    id: z.string(),
    input: z.discriminatedUnion("suite", [pure, actorInput]),
  })
  .strict();
type Msg =
  | { type: "add"; by: number }
  | { type: "reject" }
  | { type: "unknown" };
type Model = { type: "model"; n: number; owner: object };
type Cmd = { type: "effect"; n: number };
function execute(input: z.infer<typeof pure>) {
  const trace: string[] = [];
  const owner = { opaque: true };
  const cause = { detail: owner };
  const nested = new NoCellError("child-missing", "child", ["child-ok"]);
  const seed: Model = { type: "model", n: 5, owner };
  const add = (s: Model, m: Extract<Msg, { type: "add" }>) => {
    trace.push(`add:${s.n}`);
    const n = s.n + m.by;
    return [{ ...s, n }, [{ type: "effect", n }]] as const;
  };
  const reject = (s: Model): never => {
    trace.push(`reject:${s.n}`);
    if (input.scenario === "panic") throw new Error("reducer boundary panic");
    throw input.scenario === "nested-no-cell" ? nested : cause;
  };
  const lookup = input.scenario.startsWith("missing-");
  const update: Transitions<Model, Exclude<Msg, { type: "unknown" }>, Cmd> = {
    model: lookup ? { add } : { add, reject },
  };
  const machine = defineMachine({
    types: {
      model: {} as Model,
      msg: {} as Exclude<Msg, { type: "unknown" }>,
      cmd: {} as Cmd,
      ctx: undefined,
    },
    init: (): never => {
      throw new Error("update-only fold called init");
    },
    update,
    subs: [
      {
        type: "timer",
        deps: (): never => {
          throw new Error("update-only fold selected subscriptions");
        },
      },
    ],
  });
  const msgs: Msg[] =
    input.scenario === "empty"
      ? []
      : input.scenario === "ordered"
        ? [
            { type: "add", by: 2 },
            { type: "add", by: 3 },
            { type: "add", by: -1 },
          ]
        : input.scenario === "missing-first"
          ? [{ type: "unknown" }, { type: "add", by: 99 }]
          : input.scenario === "missing-middle"
            ? [
                { type: "add", by: 2 },
                { type: "unknown" },
                { type: "add", by: 99 },
              ]
            : input.scenario === "reject-middle"
              ? [
                  { type: "add", by: 2 },
                  { type: "reject" },
                  { type: "add", by: 99 },
                ]
              : [{ type: "reject" }, { type: "add", by: 99 }];
  const shared = input.verb.endsWith("shared"),
    stateOnly = input.verb.startsWith("msgs");
  let outcome: unknown,
    errorProfile: unknown = null;
  try {
    const step = stateOnly
      ? {
          state: foldMsgs(
            machine,
            seed,
            msgs as Exclude<Msg, { type: "unknown" }>[],
          ),
          cmds: null,
        }
      : foldUpdates<Model, Msg, Cmd>(machine, seed, msgs);
    outcome = {
      ok: true,
      n: step.state.n,
      cmds: step.cmds?.map((cmd) => cmd.n) ?? null,
      owner: step.state.owner === owner,
      seedSame: shared ? step.state === seed : null,
    };
  } catch (error) {
    if (error === cause || error === nested) {
      outcome = {
        ok: false,
        kind: error === nested ? "nested-no-cell" : "declared",
        sameOriginal:
          error === cause ? cause.detail === owner : error === nested,
        nested:
          error === nested
            ? {
                name: nested.name,
                _tag: nested._tag,
                message: nested.message,
                msgType: nested.msgType,
                stateName: nested.stateName,
                acceptedTypes: nested.acceptedTypes,
              }
            : null,
      };
      errorProfile = {
        category: error === nested ? "NoCellError" : "thrown-object",
      };
    } else if (error instanceof NoCellError) {
      outcome = {
        ok: false,
        kind: "lookup",
        error: {
          name: error.name,
          _tag: error._tag,
          message: error.message,
          msgType: error.msgType,
          stateName: error.stateName,
          acceptedTypes: error.acceptedTypes,
        },
      };
      errorProfile = { category: error.name };
    } else if (error instanceof Error) {
      outcome = { ok: false, kind: "panic", message: error.message };
      errorProfile = { category: error.name };
    } else throw error;
  }
  return {
    comparison: {
      outcome,
      trace,
      seedN: seed.n,
      init: 0,
      subs: 0,
      effects: 0,
      shared,
      stateOnly,
    },
    errorProfile,
  };
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let answer: unknown;
  try {
    const input = request.parse(JSON.parse(line));
    try {
      answer = {
        id: input.id,
        ok: true,
        output:
          input.input.suite === "pure"
            ? execute(input.input)
            : await executeActor(input.input),
      };
    } catch (error) {
      answer = {
        id: input.id,
        ok: false,
        error: { kind: "execution", message: String(error) },
      };
    }
  } catch (error) {
    answer = {
      id: null,
      ok: false,
      error: { kind: "protocol", message: String(error) },
    };
  }
  console.log(JSON.stringify(answer));
}
