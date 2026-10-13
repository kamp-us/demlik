// The Effect engine's half of `../old-port-family.test.ts` (#664, ADR 0026):
// the handle a live Effect run returns has neither `subscribePort` nor
// `emitPort`. It lives here because only `src/effect/` may import `effect`.
// An Effect cell is handed the Cmd alone, so there is no handler ctx to read.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { defineMachine } from "../index";
import { run } from "./index";

const REMOVED_HANDLE_MEMBERS = ["subscribePort", "emitPort"] as const;

describe("an Effect run carries no member of the old port family", () => {
  type Msg = { readonly type: "go" };
  type Ping = { readonly type: "ping" };

  const machine = defineMachine({
    types: {
      model: {} as { readonly n: number },
      msg: {} as Msg,
      cmd: {} as Ping,
      ctx: {} as { readonly tag: string },
    },
    init: () => [{ n: 0 }, []],
    update: { go: (s) => [{ n: s.n + 1 }, [{ type: "ping" }]] },
  });

  it("on its handle", async () => {
    let ran = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const booting = yield* run(machine, {
            ctx: { tag: "t" },
            interpret: {
              ping: () =>
                Effect.sync(() => {
                  ran += 1;
                }),
            },
          });
          for (const member of REMOVED_HANDLE_MEMBERS) {
            expect(member in booting).toBe(false);
          }
          const runtime = yield* booting.ready;
          for (const member of REMOVED_HANDLE_MEMBERS) {
            expect(member in runtime).toBe(false);
          }
          yield* runtime.dispatch({ type: "go" });
        }),
      ),
    );
    expect(ran).toBe(1);
  });
});
