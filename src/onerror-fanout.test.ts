import { describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  definePort,
  type Interpret,
  type Reducer,
  type RuntimeErrorContext,
  run,
  type Sub,
  type Subscribe,
  subId,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// OnError sink routing for the runtime FANOUT paths (invariant 6 — the
// runtime is inspectable; no silent failures). The sink already covered
// `follow-up` / `stop-save` / `reduce`, but the fanout sites (observers,
// listeners, port listeners, semantic-event handlers, boot handlers, sub
// cleanups) historically swallowed throws to a bare `console.error` — so a
// consumer wiring `onError` to Sentry missed exactly the "no caller to
// reject at" failures the sink exists for. These tests pin the fix: every
// fanout throw reaches the sink with a distinguishing phase, and the console
// stays silent.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly n: number; readonly subOn: boolean };
type Msg = { readonly type: "inc" } | { readonly type: "sub_off" };
type PingCmd = { readonly type: "ping" };
type TickSub = Sub<"tick">;
type BumpEvent = { readonly type: "bumped" };

const pingPort = definePort<number>("onerror-fanout.test.ping");

const update: Reducer<State, Msg, PingCmd> = {
  inc: (s) => [{ ...s, n: s.n + 1 }, [{ type: "ping" }]],
  sub_off: (s) => [{ ...s, subOn: false }, []],
};

const interpret: Interpret<Msg, PingCmd, undefined> = {
  ping: async (_cmd, ctx) => {
    ctx.emit(pingPort, 1);
  },
};

function collector() {
  const seen: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
  const onError = (error: unknown, context: RuntimeErrorContext): void => {
    seen.push({ error, context });
  };
  return { seen, onError };
}

function fanoutMachine(opts?: {
  cleanup?: () => void;
  subOn?: boolean;
}): ReturnType<typeof defineMachine<State, Msg, PingCmd, TickSub, undefined>> {
  const subscribe: Subscribe<Msg, TickSub, undefined> = {
    tick: () => opts?.cleanup ?? (() => {}),
  };
  return defineMachine<State, Msg, PingCmd, TickSub, undefined>({
    init: () => [{ n: 0, subOn: opts?.subOn ?? false }, []],
    update,
    interpret,
    subscribe,
    subscriptions: (s) =>
      s.subOn ? [{ id: subId("fanout.tick"), type: "tick" }] : [],
  });
}

describe("fanout throws route to the onError sink with distinguishing phases", () => {
  it("a throwing observer reaches the sink with phase 'observer'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("observer blew up");
    const runtime = await run(fanoutMachine(), { onError }).ready;
    runtime.observe(() => {
      throw boom;
    });
    await runtime.dispatch({ type: "inc" });
    expect(seen).toEqual([{ error: boom, context: { phase: "observer" } }]);
    await runtime.stop();
  });

  it("a throwing subscribe-listener reaches the sink with phase 'listener'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("listener blew up");
    const runtime = await run(fanoutMachine(), { onError }).ready;
    runtime.subscribe(() => {
      throw boom;
    });
    await runtime.dispatch({ type: "inc" });
    expect(seen).toEqual([{ error: boom, context: { phase: "listener" } }]);
    await runtime.stop();
  });

  it("a throwing port listener reaches the sink with phase 'port-emit'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("port listener blew up");
    const runtime = await run(fanoutMachine(), { onError }).ready;
    runtime.subscribePort(pingPort, () => {
      throw boom;
    });
    await runtime.dispatch({ type: "inc" });
    await runtime.idle();
    expect(seen).toEqual([{ error: boom, context: { phase: "port-emit" } }]);
    await runtime.stop();
  });

  it("a throwing semantic-event handler reaches the sink with phase 'event'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("event handler blew up");
    const runtime = await run(fanoutMachine(), {
      onError,
      events: (msg): readonly BumpEvent[] =>
        msg.type === "inc" ? [{ type: "bumped" }] : [],
    }).ready;
    runtime.on("bumped", () => {
      throw boom;
    });
    await runtime.dispatch({ type: "inc" });
    expect(seen).toEqual([{ error: boom, context: { phase: "event" } }]);
    await runtime.stop();
  });

  it("a throwing event PROJECTOR reaches the sink with phase 'event'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("projector blew up");
    const runtime = await run(fanoutMachine(), {
      onError,
      events: (): readonly BumpEvent[] => {
        throw boom;
      },
    }).ready;
    // The projector only runs when at least one `on` handler is registered.
    runtime.on("bumped", () => {});
    await runtime.dispatch({ type: "inc" });
    expect(seen).toEqual([{ error: boom, context: { phase: "event" } }]);
    await runtime.stop();
  });

  it("a throwing boot handler (registered pre-boot) reaches the sink with phase 'boot'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("boot handler blew up");
    const handle = run(fanoutMachine(), { onError });
    handle.onBoot(() => {
      throw boom;
    });
    const runtime = await handle.ready;
    expect(seen).toEqual([{ error: boom, context: { phase: "boot" } }]);
    await runtime.stop();
  });

  it("a throwing late onBoot handler (immediate fire, post-boot) reaches the sink with phase 'boot'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("late boot handler blew up");
    const runtime = await run(fanoutMachine(), { onError }).ready;
    runtime.onBoot(() => {
      throw boom;
    });
    expect(seen).toEqual([{ error: boom, context: { phase: "boot" } }]);
    await runtime.stop();
  });

  it("a throwing sub cleanup on reconcile-removal reaches the sink with phase 'sub-cleanup'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("sub cleanup blew up");
    const machine = fanoutMachine({
      subOn: true,
      cleanup: () => {
        throw boom;
      },
    });
    const runtime = await run(machine, { onError }).ready;
    // `sub_off` transitions the state so the reconcile pass removes the sub
    // and calls its (throwing) cleanup.
    await runtime.dispatch({ type: "sub_off" });
    expect(seen).toEqual([{ error: boom, context: { phase: "sub-cleanup" } }]);
    await runtime.stop();
  });

  it("a throwing sub cleanup during stop() reaches the sink with phase 'sub-cleanup'", async () => {
    const { seen, onError } = collector();
    const boom = new Error("stop-time cleanup blew up");
    const machine = fanoutMachine({
      subOn: true,
      cleanup: () => {
        throw boom;
      },
    });
    const runtime = await run(machine, { onError }).ready;
    await runtime.stop();
    expect(seen).toEqual([{ error: boom, context: { phase: "sub-cleanup" } }]);
  });
});

describe("vertical tracer: onError wired to a collector, console stays silent", () => {
  it("a real run captures a throwing observer's failure in the collector, not the console", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { seen, onError } = collector();
      const boom = new Error("traced observer failure");
      const runtime = await run(fanoutMachine(), { onError }).ready;
      runtime.observe(() => {
        throw boom;
      });
      await runtime.dispatch({ type: "inc" });
      await runtime.idle();
      await runtime.stop();
      expect(seen).toEqual([{ error: boom, context: { phase: "observer" } }]);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
