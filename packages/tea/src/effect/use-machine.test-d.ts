// Type-level test for #852: `useMachine` on the Effect bridge. Compiled by
// `pnpm typecheck:test`. Each `@ts-expect-error` MUST sit on a line that
// genuinely fails to type-check; every line without one is a positive case.
//
// The contract: the handlers beside `run: runIn(runtime)` are the Effect
// engine's: a cell returns an `Effect`, a runner a `Stream`, and neither reads a
// service the runtime does not provide. The Promise call shape stays as it was.

import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import {
  defineMachine,
  type FencedStore,
  type OnError,
  type Store,
  type Sub,
} from "../index";
import { run as runPromise } from "../promise";
import { useMachine } from "../react/index";
import { runIn } from "./index";

class Greeter extends Context.Service<
  Greeter,
  { readonly greet: () => string }
>()("test-d/Greeter") {}
class Clock extends Context.Service<Clock, { readonly now: () => number }>()(
  "test-d/Clock",
) {}

const runtime = ManagedRuntime.make(
  Layer.succeed(Greeter, { greet: () => "hello" }),
);

type State = { readonly n: number };
type Msg = { readonly type: "go" } | { readonly type: "done" };
type Work = { readonly type: "work" };
type Tick = Sub<"tick", { readonly every: number }>;

const withCmd = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Work,
    ctx: undefined,
  },
  init: () => [{ n: 0 }, []],
  update: {
    go: (s) => [s, [{ type: "work" }]],
    done: (s) => [{ n: s.n + 1 }, []],
  },
});
const withSub = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    sub: {} as Tick,
    ctx: undefined,
  },
  init: () => [{ n: 0 }, []],
  update: { go: (s) => [s, []], done: (s) => [{ n: s.n + 1 }, []] },
  subs: [{ type: "tick", deps: () => ({ every: 1 }) }],
});
const plain = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: undefined },
  init: () => [{ n: 0 }, []],
  update: { go: (s) => [s, []], done: (s) => [s, []] },
});

export function Components() {
  // ── interpret: an Effect, within the runtime's services ──────────────────
  const [state, send] = useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    interpret: {
      work: () =>
        Effect.gen(function* () {
          const greeter = yield* Greeter;
          return greeter.greet() === "hello"
            ? ({ type: "done" } as const)
            : undefined;
        }),
    },
  });
  const n: number = state.n;
  send({ type: "go" });
  void n;

  useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    interpret: { work: () => Effect.succeed({ type: "done" } as const) },
  });
  useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    interpret: { work: () => Effect.void },
  });
  // The run's own Scope is the one service beyond the runtime's a cell may read.
  useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    interpret: {
      work: () =>
        Effect.acquireRelease(Effect.void, () => Effect.void).pipe(
          Effect.as({ type: "done" } as const),
        ),
    },
  });
  useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    // @ts-expect-error a Promise is not an Effect
    interpret: { work: async () => ({ type: "done" }) as const },
  });
  useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    interpret: {
      // @ts-expect-error a Msg the machine does not have
      work: () => Effect.succeed({ type: "nope" } as const),
    },
  });
  useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    interpret: {
      work: () =>
        // @ts-expect-error the runtime does not provide `Clock`
        Effect.gen(function* () {
          yield* Clock;
        }),
    },
  });
  useMachine(withCmd, {
    run: runIn(runtime),
    ctx: undefined,
    interpret: {
      // @ts-expect-error a cell needing a service the runtime lacks
      work: (): Effect.Effect<void, never, Clock> => Effect.void,
    },
  });
  // @ts-expect-error a machine that emits a Cmd needs its `interpret`
  useMachine(withCmd, { run: runIn(runtime), ctx: undefined });

  // ── subscribe: a Stream, within the runtime's services ───────────────────
  useMachine(withSub, {
    run: runIn(runtime),
    ctx: undefined,
    subscribe: { tick: () => Stream.make({ type: "done" } as const) },
  });
  useMachine(withSub, {
    run: runIn(runtime),
    ctx: undefined,
    subscribe: {
      tick: () =>
        Stream.unwrap(
          Effect.map(Greeter, () => Stream.make({ type: "go" } as const)),
        ),
    },
  });
  useMachine(withSub, {
    run: runIn(runtime),
    ctx: undefined,
    // @ts-expect-error a Promise-engine runner returns a `Dispose`, not a Stream
    subscribe: { tick: (_sub, _ctx, _dispatch) => () => {} },
  });
  useMachine(withSub, {
    run: runIn(runtime),
    ctx: undefined,
    subscribe: {
      // @ts-expect-error a runner needing a service the runtime lacks
      tick: (): Stream.Stream<Msg, never, Clock> => Stream.never,
    },
  });
  // @ts-expect-error a machine with a Sub beyond `timer` needs its `subscribe`
  useMachine(withSub, { run: runIn(runtime), ctx: undefined });

  // ── nothing to handle: no handlers asked for ─────────────────────────────
  useMachine(plain, { run: runIn(runtime), ctx: undefined });

  // ── the Promise call shape is as it was ──────────────────────────────────
  useMachine(withCmd, {
    run: runPromise,
    ctx: undefined,
    interpret: { work: async () => ({ type: "done" }) as const },
  });
  useMachine(withSub, {
    run: runPromise,
    ctx: undefined,
    subscribe: { tick: () => () => {} },
  });
  useMachine(withCmd, {
    run: runPromise,
    ctx: undefined,
    // @ts-expect-error an Effect is not a Promise
    interpret: { work: () => Effect.void },
  });
}

// ── a fenced store through the bridge needs its `onError` (ADR 0031) ────────

declare const fenced: FencedStore<State>;
declare const unfenced: Store<State>;
declare const onError: OnError;

export function Stores() {
  useMachine(plain, { run: runIn(runtime), ctx: undefined, store: unfenced });
  useMachine(plain, {
    run: runIn(runtime),
    ctx: undefined,
    store: fenced,
    onError,
  });
  // @ts-expect-error a fenced store with no `onError`
  useMachine(plain, { run: runIn(runtime), ctx: undefined, store: fenced });
  // @ts-expect-error `onError: undefined` is no sink either
  useMachine(plain, {
    run: runIn(runtime),
    ctx: undefined,
    store: fenced,
    onError: undefined,
  });
}
