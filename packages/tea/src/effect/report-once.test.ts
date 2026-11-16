import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { defineMachine, type RuntimeErrorPhase } from "../index";
import { run, tell } from "./index";

type State = { readonly n: number };
type Msg =
  | { readonly _tag: "boom" }
  | { readonly _tag: "kick" }
  | { readonly _tag: "inc" };
type Fire = { readonly _tag: "fire" };

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, cmd: {} as Fire },
  init: () => [{ n: 0 }, []],
  update: {
    boom: () => {
      throw new Error("reducer threw");
    },
    kick: (s) => [s, [{ _tag: "fire" }]],
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
              fire: () => Effect.succeed({ _tag: "boom" } as const),
            },
            supervision: "escalate",
            onError: (_error, context) => phases.push(context.phase),
          })).ready;

          if (source === "tell") {
            expect(yield* tell(machine, runtime, { _tag: "boom" })).toBe(
              "queued",
            );
          } else {
            yield* runtime.dispatch({ _tag: "kick" });
          }
          yield* runtime.idle();
          expect(phases).toEqual(["reduce"]);
          yield* runtime.dispatch({ _tag: "inc" });
          expect(runtime.getState()).toEqual({ n: 1 });
        }),
      ),
    );
  });
});
