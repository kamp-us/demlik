import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Cmd,
  DispatchDiscardedError,
  defineMachine,
  type Identity,
  type Interpret,
  type MalformedResult,
  type NoCtx,
  type Reducer,
  RuntimeDiscardedError,
  type RuntimeErrorContext,
  type Settled,
  type Store,
  StoreConflictError,
  type Sub,
  type TelemetryEvent,
} from "../index";
import { memoryStore } from "../mem";
import { cmdEdgeOf } from "../pure/core";
import { run } from "./index";

// ───────────────────────────────────────────────────────────────────────────
// The small core (#280, spike #264). `./loop` knows no built-in; every one of
// them comes back as an extension. This file pins the spike's eleven cases
// against the real loop, plus the two it left out: the `stop()` drain/discard
// gate and the ctx contribution a composed handler settles through.
// ───────────────────────────────────────────────────────────────────────────

describe("the core loop file names no built-in", () => {
  const source = readFileSync(new URL("./loop.ts", import.meta.url), "utf8");

  it.each([
    ["identity", /identity/i],
    ["events", /\bevents?\b/i],
    ["terminal", /terminal/i],
    ["supervision", /supervis/i],
    ["fencing", /fenc/i],
    ["schema checks", /schema/i],
    ["clock stamping", /clock|stamp/i],
  ])("no reference to %s", (_name, pattern) => {
    expect(source).not.toMatch(pattern);
  });
});

const fetch = Cmd.define("fetch", {
  input: z.object({}),
  ok: z.object({ n: z.number() }),
  err: ["nope"],
});
type FetchCmd = ReturnType<typeof fetch>;
type FetchSettled = Settled<typeof fetch>;

type Model = {
  readonly owner: string | undefined;
  readonly n: number;
  readonly lastError: string | null;
  readonly ats: readonly number[];
  readonly done: boolean;
  readonly bag: { count: number };
};
type Msg =
  | { readonly type: "bump"; readonly to?: string }
  | { readonly type: "explode" }
  | { readonly type: "mutate" }
  | { readonly type: "misaddress" }
  | { readonly type: "load" }
  | { readonly type: "finish" };

const fresh: Model = {
  owner: "run-a",
  n: 0,
  lastError: null,
  ats: [],
  done: false,
  bag: { count: 0 },
};

const update: Reducer<Model, Msg | FetchSettled, FetchCmd> = {
  bump: (m) => [{ ...m, n: m.n + 1 }, []],
  explode: () => {
    throw new Error("reducer boom");
  },
  mutate: (m) => {
    // An in-place mutation: the dev checks freeze the input State first.
    (m.bag as { count: number }).count += 1;
    return [m, []];
  },
  misaddress: (m) => [m, []],
  load: (m) => [m, [fetch({})]],
  finish: (m) => [{ ...m, done: true }, []],
  fetch_ok: (m, msg) => [{ ...m, n: msg.value.n, ats: [...m.ats, msg.at] }, []],
  fetch_err: (m, msg) => [
    { ...m, lastError: msg.error._tag, ats: [...m.ats, msg.at] },
    [],
  ],
};

const identity: Identity<Model, Msg | FetchSettled> = {
  ofState: (s) => s.owner,
  ofMsg: (msg) => {
    if (msg.type === "misaddress") throw new Error("ofMsg boom");
    return msg.type === "bump" ? msg.to : undefined;
  },
};

const machine = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, ctx: {} as NoCtx },
  cmds: [fetch],
  init: (loaded) => [loaded ?? fresh, []],
  update,
  identity,
});

function answering(
  value: unknown,
): Interpret<Msg | FetchSettled, FetchCmd, NoCtx> {
  return { fetch: async (_cmd, { ok }) => ok(value as { n: number }) };
}

function sink() {
  const reports: { error: unknown; phase: string }[] = [];
  const onError = (error: unknown, context: RuntimeErrorContext) => {
    reports.push({ error, phase: context.phase });
  };
  return { reports, onError };
}

function spiedStore(initial: Model | null = null): Store<Model> & {
  saves: Model[];
} {
  const inner = memoryStore<Model>(initial);
  const saves: Model[] = [];
  return {
    saves,
    load: () => inner.load(),
    migrate: (raw) => inner.migrate(raw),
    async save(state) {
      saves.push(state);
      await inner.save(state);
    },
  };
}

describe("spike #264's eleven cases, against the new loop", () => {
  it("1. an identity drop resolves, saves nothing and reports identity-drop", async () => {
    const store = spiedStore();
    const { reports, onError } = sink();
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      store,
      onError,
    }).ready;
    const savesAtBoot = store.saves.length;

    await expect(rt.dispatch({ type: "bump", to: "run-b" })).resolves.toBe(
      undefined,
    );

    expect(rt.getState().n).toBe(0);
    expect(store.saves).toHaveLength(savesAtBoot);
    expect(reports.map((r) => r.phase)).toEqual(["identity-drop"]);
    await rt.stop();
  });

  it("2. a throwing ofMsg is supervised like a reducer throw", async () => {
    const { reports, onError } = sink();
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      supervision: "escalate",
      onError,
    }).ready;

    await expect(rt.dispatch({ type: "misaddress" })).rejects.toThrow(
      "ofMsg boom",
    );
    expect(reports.map((r) => r.phase)).toEqual(["reduce"]);
    // Escalate leaves the runtime live.
    await rt.dispatch({ type: "bump" });
    expect(rt.getState().n).toBe(1);
    await rt.stop();
  });

  it("3. events project applied transitions to `on` handlers", async () => {
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      events: (msg, state) =>
        msg.type === "bump" ? [{ type: "bumped" as const, n: state.n }] : [],
    }).ready;
    const seen: number[] = [];
    rt.on("bumped", (event) => {
      seen.push(event.n);
    });

    await rt.dispatch({ type: "bump" });
    await rt.dispatch({ type: "finish" });
    await rt.dispatch({ type: "bump" });

    expect(seen).toEqual([1, 2]);
    await rt.stop();
  });

  it("4. terminal: result() and done() settle on the first terminal commit", async () => {
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      terminal: (s) => s.done,
    }).ready;
    expect(rt.result()).toBeUndefined();
    const done = rt.done();

    await rt.dispatch({ type: "finish" });

    await expect(done).resolves.toMatchObject({ done: true });
    expect(rt.result()).toMatchObject({ done: true });
    await rt.stop();
  });

  it("5. terminal: a boot that rehydrates terminal settles done() at boot", async () => {
    const handle = run(machine, {
      interpret: answering({ n: 1 }),
      store: memoryStore<Model>({ ...fresh, done: true }),
      terminal: (s) => s.done,
    });
    const rt = await handle.ready;
    await expect(rt.done()).resolves.toMatchObject({ done: true });
    expect(rt.result()).toMatchObject({ done: true });
    await rt.stop();
  });

  it("6. supervision stop: the throw rejects and the gate stays shut", async () => {
    const { reports, onError } = sink();
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      onError,
    }).ready;

    await expect(rt.dispatch({ type: "explode" })).rejects.toThrow(
      "reducer boom",
    );
    await expect(rt.dispatch({ type: "bump" })).rejects.toThrow(
      "runtime stopped",
    );
    expect(reports.map((r) => r.phase)).toEqual(["reduce"]);
    await rt.stop();
  });

  it("7. supervision escalate: the throw rejects and the runtime stays live", async () => {
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      supervision: "escalate",
      onError: () => {},
    }).ready;

    await expect(rt.dispatch({ type: "explode" })).rejects.toThrow(
      "reducer boom",
    );
    await rt.dispatch({ type: "bump" });
    expect(rt.getState().n).toBe(1);
    await rt.stop();
  });

  it("8. supervision restart: the rehydrated State commits under the throwing Msg", async () => {
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      supervision: {
        strategy: "restart",
        rehydrate: (s) => ({ ...s, n: -1 }),
      },
      onError: () => {},
    }).ready;
    const seen: string[] = [];
    rt.observe((msg) => {
      seen.push(msg.type);
    });

    await rt.dispatch({ type: "explode" });

    expect(rt.getState().n).toBe(-1);
    expect(seen).toEqual(["explode"]);
    await rt.stop();
  });

  it("9. fenced store: the second writer takes the fence; the first is refused before its Cmd runs", async () => {
    const shared = memoryStore<Model>(null, undefined, { fenced: true });
    const firstHandler = vi.fn(answering({ n: 1 }).fetch);
    const first = await run(machine, {
      interpret: { fetch: firstHandler },
      store: shared,
    }).ready;
    const second = await run(machine, {
      interpret: answering({ n: 2 }),
      store: shared,
    }).ready;

    await second.dispatch({ type: "bump" });
    const refused = first.dispatch({ type: "load" });

    await expect(refused).rejects.toBeInstanceOf(StoreConflictError);
    await expect(refused).rejects.toMatchObject({ _tag: "store_conflict" });
    expect(firstHandler).not.toHaveBeenCalled();
    await second.stop();
  });

  it("10. the ok-schema check: a malformed ok becomes fetch_err (malformed_result), stamped", async () => {
    let settled: FetchSettled | undefined;
    const rt = await run(machine, {
      interpret: answering({ n: "seven" }),
      clock: () => 42,
    }).ready;
    rt.observe((msg) => {
      if (msg.type === "fetch_err") settled = msg;
    });

    await rt.dispatch({ type: "load" });

    expect(rt.getState().lastError).toBe("malformed_result");
    expect(rt.getState().ats).toEqual([42]);
    const issues = (settled as { error: MalformedResult }).error.issues;
    expect(issues[0]?.path).toBe("n");
    await rt.stop();
  });

  it("11. the clock: a well-formed ok folds in parsed and stamped with `at`", async () => {
    const rt = await run(machine, {
      interpret: answering({ n: 7, extra: "stripped" }),
      clock: () => 42,
    }).ready;

    await rt.dispatch({ type: "load" });

    expect(rt.getState().n).toBe(7);
    expect(rt.getState().ats).toEqual([42]);
    await rt.stop();
  });

  it("dev checks: an in-place State mutation trips inside supervision", async () => {
    const { reports, onError } = sink();
    const rt = await run(machine, {
      interpret: answering({ n: 1 }),
      supervision: "escalate",
      onError,
    }).ready;

    await expect(rt.dispatch({ type: "mutate" })).rejects.toThrow();
    expect(rt.getState().bag.count).toBe(0);
    expect(reports.map((r) => r.phase)).toEqual(["reduce"]);
    await rt.stop();
  });
});

describe("the core's sub reconcile", () => {
  type Tick = Sub<"tick", { readonly every: number }>;
  type TModel = { readonly every: number | null };
  type TMsg = { readonly type: "set"; readonly every: number | null };
  const ticker = defineMachine({
    types: {
      model: {} as TModel,
      msg: {} as TMsg,
      sub: {} as Tick,
      ctx: {} as NoCtx,
    },
    init: () => [{ every: 10 }, []],
    update: { set: (_s, msg) => [{ every: msg.every }, []] },
    subs: [
      {
        type: "tick",
        deps: (s: TModel) => (s.every === null ? null : { every: s.every }),
      },
    ],
  });

  it("arms, leaves an unchanged Sub alone, re-arms on a deps change and disposes", async () => {
    const log: string[] = [];
    const rt = await run(ticker, {
      subscribe: {
        tick: (sub) => {
          log.push(`start ${sub.deps.every}`);
          return () => {
            log.push(`stop ${sub.deps.every}`);
          };
        },
      },
    }).ready;

    await rt.dispatch({ type: "set", every: 10 });
    await rt.dispatch({ type: "set", every: 20 });
    await rt.dispatch({ type: "set", every: null });

    expect(log).toEqual(["start 10", "stop 10", "start 20", "stop 20"]);
    await rt.stop();
  });
});

describe("what spike #264 left out", () => {
  it("stop() drains in-flight work and discards its follow-up as DispatchDiscardedError", async () => {
    type DModel = { readonly got: number };
    type DMsg = { readonly type: "go" } | { readonly type: "got" };
    type DCmd = { readonly type: "wait" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drained = defineMachine({
      types: {
        model: {} as DModel,
        msg: {} as DMsg,
        cmd: {} as DCmd,
        ctx: {} as NoCtx,
      },
      init: () => [{ got: 0 }, []],
      update: {
        go: (s) => [s, [{ type: "wait" }]],
        got: (s) => [{ got: s.got + 1 }, []],
      },
    });
    const { reports, onError } = sink();
    const rt = await run(drained, {
      interpret: {
        wait: async () => {
          await gate;
          return { type: "got" } as const;
        },
      },
      onError,
    }).ready;

    const dispatched = rt.dispatchOnce({ type: "go" });
    await Promise.resolve();
    const stopped = rt.stop();
    release();
    await dispatched;
    await stopped;

    expect(rt.getState().got).toBe(0);
    const discards = reports.filter((r) => r.phase === "discard");
    expect(discards.map((r) => r.error)).toEqual([
      expect.any(RuntimeDiscardedError),
      expect.any(DispatchDiscardedError),
    ]);
    await expect(rt.dispatch({ type: "go" })).rejects.toThrow(
      "runtime stopped",
    );
  });

  it("a handler composed inside another settles through the same edge on ctx", async () => {
    // The carrier shape (`withResilience`'s `$resilience:run`, the agent's
    // fanned tools): one Cmd's handler runs another Cmd's handler inside its
    // own and settles that outcome itself, through the edge `run` put on ctx —
    // one mint, one parse, one clock.
    const carry = Cmd.define("carry", {
      input: z.object({}),
      ok: z.undefined(),
      err: [],
    });
    type CModel = { readonly n: number; readonly ats: readonly number[] };
    type CSettled = Settled<typeof fetch> | Settled<typeof carry>;
    const carrier = defineMachine({
      types: {
        model: {} as CModel,
        msg: {} as { readonly type: "go" },
        ctx: {} as NoCtx,
      },
      cmds: [fetch, carry],
      init: () => [{ n: 0, ats: [] }, []],
      update: {
        go: (m: CModel) => [m, [carry({})]],
        fetch_ok: (m: CModel, msg: Extract<CSettled, { type: "fetch_ok" }>) => [
          { n: msg.value.n, ats: [...m.ats, msg.at] },
          [],
        ],
        fetch_err: (m: CModel) => [m, []],
        carry_ok: (m: CModel) => [m, []],
        carry_err: (m: CModel) => [m, []],
      },
    });
    const baseFetch: Interpret<
      { readonly type: "go" } | CSettled,
      ReturnType<typeof fetch> | ReturnType<typeof carry>,
      NoCtx
    >["fetch"] = async (_cmd, { ok }) => ok({ n: 5 });
    const rt = await run(carrier, {
      interpret: {
        fetch: baseFetch,
        carry: async (_cmd, ctx, dispatch) => {
          const inner = fetch({});
          const settled = cmdEdgeOf(ctx)(
            inner,
            await baseFetch(inner, ctx as never),
          );
          dispatch?.(settled as CSettled);
          return ctx.ok(undefined);
        },
      },
      clock: () => 9,
    }).ready;

    await rt.dispatch({ type: "go" });

    expect(rt.getState()).toEqual({ n: 5, ats: [9] });
    await rt.stop();
  });
});

describe("telemetry (withTelemetry moved inside the loop, #268)", () => {
  it("hands the sink { seq, msgType, at } per applied transition, never boot or a drop", async () => {
    const events: TelemetryEvent[] = [];
    const rt = await run(machine, {
      interpret: answering({ n: 3 }),
      clock: () => 42,
      onError: () => {},
      telemetry: (event) => {
        events.push(event);
      },
    }).ready;

    await rt.dispatch({ type: "bump" });
    await rt.dispatch({ type: "bump", to: "run-b" });
    await rt.dispatch({ type: "load" });

    expect(events).toEqual([
      { seq: 1, msgType: "bump", at: 42 },
      { seq: 2, msgType: "load", at: 42 },
      { seq: 3, msgType: "fetch_ok", at: 42 },
    ]);
    await rt.stop();
  });

  it("a failing sink reaches onError under observer and never touches the run", async () => {
    const { reports, onError } = sink();
    const rt = await run(machine, {
      interpret: answering({ n: 3 }),
      onError,
      telemetry: () => Promise.reject(new Error("sink down")),
    }).ready;

    await rt.dispatch({ type: "bump" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rt.getState().n).toBe(1);
    expect(reports).toEqual([
      { error: new Error("sink down"), phase: "observer" },
    ]);
    await rt.stop();
  });
});
