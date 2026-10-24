import { z } from "zod";
import {
  defineMachine,
  foldMsgs,
  NoCellError,
  type Reducer,
  replay,
  type Transitions,
} from "../../packages/tea/src/index.ts";

const state = z.object({ type: z.enum(["ready", "done"]), count: z.number() });
const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), by: z.number() }),
  z.object({ type: z.literal("finish") }),
  z.object({ type: z.literal("unknown") }),
]);
export const coreInput = z.object({
  form: z.enum(["reducer", "transitions"]),
  mode: z.enum(["replay", "fold"]),
  base: state.optional(),
  loaded: state.nullable().optional(),
  initialCount: z.number(),
  restoredBump: z.number(),
  msgs: z.array(message),
});
type State = z.infer<typeof state>;
type Msg = z.infer<typeof message>;
type HandledMsg = Exclude<Msg, { type: "unknown" }>;
type Cmd = { type: "boot" | "resume" | "added" | "finished"; count: number };

export function executeCore(input: z.infer<typeof coreInput>) {
  let initCalls = 0;
  let depsCalls = 0;
  const add: Reducer<State, HandledMsg, Cmd>["add"] = (s, m) => [
    { type: s.type, count: s.count + m.by },
    [{ type: "added", count: m.by }],
  ];
  const finish: Reducer<State, HandledMsg, Cmd>["finish"] = (s) => [
    { type: "done", count: s.count },
    [{ type: "finished", count: s.count }],
  ];
  const reducer: Reducer<State, HandledMsg, Cmd> = { add, finish };
  const transitions: Transitions<State, HandledMsg, Cmd> = {
    ready: { add, finish },
    done: {},
  };
  const definition = {
    types: {
      model: {} as State,
      msg: {} as HandledMsg,
      cmd: {} as Cmd,
      ctx: undefined,
    },
    init: (loaded: State | null): readonly [State, readonly Cmd[]] => {
      initCalls++;
      const count =
        loaded === null
          ? input.initialCount
          : loaded.count + input.restoredBump;
      return [
        { type: loaded?.type ?? "ready", count },
        [{ type: loaded === null ? "boot" : "resume", count }],
      ];
    },
    subs: [0, 1].map(() => ({
      type: "pulse",
      deps: (s: State) => {
        depsCalls++;
        return s.type === "ready" ? { count: s.count } : null;
      },
    })),
  };
  const machine =
    input.form === "reducer"
      ? defineMachine({ ...definition, update: reducer })
      : defineMachine({ ...definition, update: transitions });
  try {
    // A wire message can name a cell absent from the typed table. That is the
    // refusal contract being exercised, so the assertion is confined here.
    const msgs = input.msgs as HandledMsg[];
    const base: State = input.base ?? { type: "ready", count: 0 };
    const result =
      input.mode === "replay"
        ? replay(machine, { loaded: input.loaded, ctx: undefined, msgs })
        : { state: foldMsgs(machine, base, msgs) };
    return { ...result, initCalls, depsCalls };
  } catch (error) {
    if (!(error instanceof NoCellError)) throw error;
    return {
      refusal: {
        name: error.name,
        _tag: error._tag,
        message: error.message,
        msgType: error.msgType,
        stateName: error.stateName,
        acceptedTypes: error.acceptedTypes,
      },
      initCalls,
      depsCalls,
    };
  }
}
