import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { defineMachine, type RuntimeErrorPhase } from "../index";
import { run, tell } from "./index";

type State = { readonly n: number };
type Msg =
  | { readonly type: "boom" }
  | { readonly type: "kick" }
  | { readonly type: "inc" };
type Fire = { readonly type: "fire" };

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, cmd: {} as Fire },
  init: () => [{ n: 0 }, []],
  update: {
    boom: () => {
      throw new Error("reducer threw");
    },
    kick: (s) => [s, [{ type: "fire" }]],
    inc: (s) => [{ n: s.n + 1 }, []],
  },
});

describe("a reducer throw on the Effect engine reaches the sink once", () => {
  it.each(["tell", "Cmd reply"] as const)("through %s", async (source) => {
    const phases: RuntimeErrorPhase[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* (yield* run(machine, {
            interpret: {
              fire: () => Effect.succeed({ type: "boom" } as const),
            },
            supervision: "escalate",
            onError: (_error, context) => phases.push(context.phase),
          })).ready;

          if (source === "tell") {
            expect(yield* tell(machine, runtime, { type: "boom" })).toBe(
              "queued",
            );
          } else {
            yield* runtime.dispatch({ type: "kick" });
          }
          yield* runtime.idle();
          expect(phases).toEqual(["reduce"]);
          yield* runtime.dispatch({ type: "inc" });
          expect(runtime.getState()).toEqual({ n: 1 });
        }),
      ),
    );
  });
});
