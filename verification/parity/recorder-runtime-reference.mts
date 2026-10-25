import assert from "node:assert/strict";
import { Effect, Exit, Scope } from "effect";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  type BootingRuntime,
  defineMachine,
} from "../../packages/tea/src/index.ts";
import {
  parseJSONL,
  type Recorder,
  recorder,
} from "../../packages/tea/src/internal/persistence/recorder/index.ts";
import { replayTrace } from "../../packages/tea/src/internal/persistence/trace-replay/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";

class Token {
  #value: number;
  constructor(value: number) {
    this.#value = value;
  }
  get value() {
    return this.#value;
  }
  set value(value: number) {
    this.#value = value;
  }
  toJSON() {
    return { value: this.#value };
  }
}
type State = {
  type: "counting";
  count: number;
  log: readonly string[];
  token: Token;
};
type Msg =
  | { type: "add"; by: number; token: Token }
  | { type: "note"; text: string };
type Command = { type: "write" };
type Context = { start: number; token: Token };
for (const profile of ["Promise", "Effect"] as const)
  for (const captureSteps of [false, true])
    for (const sampled of [false, true]) {
      const counts = { init: 0, update: 0, subs: 0, handler: 0 };
      const reports: unknown[] = [];
      const token = new Token(7);
      let randomCalls = 0;
      const machine = () =>
        defineMachine({
          types: {
            model: {} as State,
            msg: {} as Msg,
            cmd: {} as Command,
            ctx: {} as Context,
          },
          init: (loaded, ctx) => {
            counts.init++;
            return [
              {
                type: "counting",
                count: (loaded?.count ?? ctx.start) + 10,
                log: loaded?.log ?? [],
                token: loaded?.token ?? ctx.token,
              },
              [{ type: "write" }],
            ] as const;
          },
          update: {
            add: (state, msg) => {
              counts.update++;
              return [{ ...state, count: state.count + msg.by }, []] as const;
            },
            note: (state, msg) => {
              counts.update++;
              return [{ ...state, log: [...state.log, msg.text] }, []] as const;
            },
          },
          subs: [
            {
              type: "timer",
              deps: () => {
                counts.subs++;
                return null;
              },
            },
          ],
        });
      const scope = Effect.runSync(Scope.make());
      let rec: Recorder<State, Msg>;
      let dispatch: (msg: Msg) => Promise<void>;
      let idle: () => Promise<void>;
      let stop: () => Promise<void>;
      let getState: () => State;
      const originalRandom = Math.random;
      let off = () => {};
      const observed: { msg: Msg; state: State }[] = [];
      try {
        const opts = { sampleRate: sampled ? 0.5 : 1, captureSteps };
        if (profile === "Promise") {
          const boot = runPromise(machine(), {
            ctx: { start: 4, token },
            onError: (error) => {
              reports.push(error);
            },
            interpret: {
              write: async () => {
                counts.handler++;
                return { type: "add", by: 1, token } as const;
              },
            },
          });
          Math.random = () => [0.1, 0.9, 0.1, 0.9][randomCalls++];
          rec = recorder(boot, opts);
          off = boot.observe((msg, state) => observed.push({ msg, state }));
          const rt = await boot.ready;
          dispatch = (msg) => rt.dispatch(msg);
          idle = () => rt.idle();
          stop = () => rt.stop();
          getState = () => rt.getState();
        } else {
          const boot = Effect.runSync(
            Scope.provide(scope)(
              runEffect(machine(), {
                ctx: { start: 4, token },
                onError: (error) => {
                  reports.push(error);
                },
                interpret: {
                  write: () =>
                    Effect.sync(() => {
                      counts.handler++;
                      return { type: "add", by: 1, token } as const;
                    }),
                },
              }),
            ),
          );
          Math.random = () => [0.1, 0.9, 0.1, 0.9][randomCalls++];
          // Recorder reads the same synchronous observe/onBoot hooks; Effect's waiting verbs differ.
          rec = recorder(boot as unknown as BootingRuntime<State, Msg>, opts);
          off = boot.observe((msg, state) => observed.push({ msg, state }));
          const rt = await Effect.runPromise(boot.ready);
          dispatch = (msg) => Effect.runPromise(rt.dispatch(msg));
          idle = () => Effect.runPromise(rt.idle());
          stop = () => Effect.runPromise(rt.stop());
          getState = () => rt.getState();
        }
        await idle();
        await dispatch({ type: "add", by: 2, token });
        await dispatch({ type: "note", text: "opaque note" });
        await dispatch({ type: "add", by: 3, token });
        await idle();
        const trace = rec.dump();
        assert.equal(trace.loaded?.count, 14, `${profile} boot anchor`);
        assert.equal(trace.finalState.count, 20);
        assert.equal(trace.finalState, getState());
        assert.equal(observed.length, 4);
        const kept = sampled ? [0, 2] : [0, 1, 2, 3];
        trace.msgs.forEach((msg, i) => {
          assert.equal(msg, observed[kept[i]].msg);
        });
        assert.equal(trace.steps !== undefined, captureSteps);
        assert.equal(randomCalls, sampled ? 4 : 0);
        const parsed = parseJSONL<State, Msg>(rec.toJSONL());
        assert.equal(
          parsed.finalState.count,
          sampled && captureSteps ? 17 : 20,
        );
        const before = { ...counts };
        const cold = replayTrace(machine(), parsed, {
          start: 999,
          token: new Token(999),
        });
        assert.equal(cold.matches, !sampled);
        assert.equal(cold.actual.count, sampled ? 15 : 20);
        assert.equal(cold.expected, parsed.finalState);
        assert.equal(counts.init, before.init);
        assert.equal(counts.handler, before.handler);
        assert.equal(counts.subs, before.subs);
        rec.stop();
        rec.stop();
        await dispatch({ type: "add", by: 100, token });
        assert.equal(rec.dump().finalState, trace.finalState);
        assert.equal(rec.dump().msgs.length, kept.length);
        off();
        await stop();
        token.value = 9;
        assert.equal(trace.finalState.token.value, 9);
        assert.equal(trace.loaded?.token.value, 9);
        assert.equal(parsed.finalState.token.value, 7);
        assert.equal(reports.length, 0);
        console.log(
          JSON.stringify({
            profile,
            captureSteps,
            sampled,
            anchor: trace.loaded?.count,
            recorded: trace.msgs.length,
            dumpFinal: trace.finalState.count,
            wireFinal: parsed.finalState.count,
            actual: cold.actual.count,
            matches: cold.matches,
            initCalls: before.init,
            handlerCalls: before.handler,
            selectorCallsUnchanged: true,
            reports: reports.length,
          }),
        );
      } finally {
        Math.random = originalRandom;
        off();
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
      }
    }
