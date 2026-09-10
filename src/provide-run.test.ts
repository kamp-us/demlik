import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doStore } from "./do";
import {
  defineMachine,
  driveToDone,
  type Interpret,
  layer,
  ProvideFailedError,
  provide,
  type Reducer,
  replay,
  run,
  type Store,
  value,
} from "./index";
import { memoryStore } from "./mem";
import { fileStore } from "./node";

// ───────────────────────────────────────────────────────────────────────────
// The provider graph AT THE RUN SEAM (#183): `run(machine, { ctx: provide(…) })`
// acquires the graph at boot and releases it at `stop()` — which every terminal
// funnels through, since `driveToDone` stops in a `finally`.
//
// The graph's own contract (order, memoization, isolated releases) is pinned in
// `src/provide/index.test.ts`. What is pinned HERE is the lifetime: which run
// events acquire, which release, and that neither is visible in the journal.
// ───────────────────────────────────────────────────────────────────────────

/** A db handle with a lifetime — the canonical scoped resource. */
interface Db {
  readonly url: string;
  readonly rows: string[];
  open: boolean;
}

type State = {
  readonly phase: "running" | "done" | "failed" | "cancelled";
  readonly writes: number;
};
type Msg =
  | { readonly type: "write" }
  | { readonly type: "finish" }
  | { readonly type: "fail" }
  | { readonly type: "cancel" };
type Ctx = { readonly db: Db };

/**
 * One machine for every case below: `write` runs a Cmd that touches the db
 * handle the graph provided, and the three terminals are three Msgs so a test
 * picks its own ending.
 */
function dbMachine() {
  const update: Reducer<State, Msg, { readonly type: "persist" }> = {
    write: (s) => [{ ...s, writes: s.writes + 1 }, [{ type: "persist" }]],
    finish: (s) => [{ ...s, phase: "done" }, []],
    fail: (s) => [{ ...s, phase: "failed" }, []],
    cancel: (s) => [{ ...s, phase: "cancelled" }, []],
  };
  const interpret: Interpret<Msg, { readonly type: "persist" }, Ctx> = {
    persist: async (_cmd, ctx) => {
      // Reading the handle is what makes the lifetime load-bearing: a released
      // db here would be a use-after-free, which is the bug the scope prevents.
      ctx.db.rows.push(`row-${ctx.db.rows.length}`);
      // No follow-up Msg: the write is the whole effect.
    },
  };
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as { readonly type: "persist" },
      ctx: {} as Ctx,
    },
    init: (_loaded) => [{ phase: "running", writes: 0 }, []],
    update,
    interpret,
  });
}

const isTerminal = (s: State): boolean => s.phase !== "running";
const isFailed = (s: State): boolean => s.phase === "failed";

/** The graph under test, plus the trace its acquires and releases write. */
function dbGraph(trace: string[]) {
  return provide({
    config: layer(
      () => {
        trace.push("acquire:config");
        return { url: "postgres://test" };
      },
      () => {
        trace.push("release:config");
      },
    ),
    db: layer(
      ["config"],
      (deps: { config: { url: string } }): Db => {
        trace.push("acquire:db");
        return { url: deps.config.url, rows: [], open: true };
      },
      (db: Db) => {
        trace.push("release:db");
        db.open = false;
      },
    ),
  });
}

describe("run(ctx: provide(…)) — the lifetime across a run", () => {
  it("acquires at boot, in dependency order, before any handler sees ctx", async () => {
    const trace: string[] = [];
    const handle = run(dbMachine(), { ctx: dbGraph(trace) });

    const rt = await handle.ready;
    // The whole graph stood up during boot, dependencies first — and boot is
    // what `ready` resolves on, so a handler cannot run before it.
    expect(trace).toEqual(["acquire:config", "acquire:db"]);

    await rt.dispatch({ type: "write" });
    await rt.stop();
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);
  });

  it("releases in reverse, exactly once, on a DONE run", async () => {
    const trace: string[] = [];
    const state = await driveToDone(
      run(dbMachine(), { ctx: dbGraph(trace) }),
      { type: "finish" },
      isTerminal,
    );

    expect(state.phase).toBe("done");
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);
  });

  it("releases in reverse, exactly once, on a FAILED run", async () => {
    const trace: string[] = [];
    const failure = await driveToDone(
      run(dbMachine(), { ctx: dbGraph(trace) }),
      { type: "fail" },
      isTerminal,
      { failed: isFailed },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);
  });

  it("releases in reverse, exactly once, on a CANCELLED run", async () => {
    const trace: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const state = await driveToDone(
      run(dbMachine(), { ctx: dbGraph(trace) }),
      { type: "write" },
      isTerminal,
      {
        signal: controller.signal,
        cancel: (): Msg => ({ type: "cancel" }),
      },
    );

    expect(state.phase).toBe("cancelled");
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);
  });

  it("releases once even when `stop()` is called twice", async () => {
    const trace: string[] = [];
    const handle = run(dbMachine(), { ctx: dbGraph(trace) });
    await handle.ready;
    await handle.stop();
    await handle.stop();

    expect(trace.filter((entry) => entry === "release:db")).toHaveLength(1);
  });

  it("holds the resource open for the whole run and closes it after", async () => {
    let handle: Db | null = null;
    const graph = provide({
      db: layer(
        (): Db => {
          handle = { url: "postgres://test", rows: [], open: true };
          return handle;
        },
        (db: Db) => {
          db.open = false;
        },
      ),
    });

    const rt = await run(dbMachine(), { ctx: graph }).ready;
    await rt.dispatch({ type: "write" });
    await rt.dispatch({ type: "write" });
    expect(handle).not.toBeNull();
    expect((handle as unknown as Db).open).toBe(true);
    expect((handle as unknown as Db).rows).toEqual(["row-0", "row-1"]);

    await rt.stop();
    expect((handle as unknown as Db).open).toBe(false);
  });
});

describe("run(ctx: provide(…)) — failure at the edges", () => {
  it("surfaces an acquire failure as a typed failure, never an uncaught throw", async () => {
    const trace: string[] = [];
    const reported: { error: unknown; phase: string }[] = [];
    const graph = provide({
      config: layer(
        () => {
          trace.push("acquire:config");
          return { url: "postgres://test" };
        },
        () => {
          trace.push("release:config");
        },
      ),
      db: layer(["config"], (_deps: { config: { url: string } }): Db => {
        throw new Error("connection refused");
      }),
    });

    // `run` itself does not throw — the graph opens on the boot tail.
    const handle = run(dbMachine(), {
      ctx: graph,
      onError: (error, context) =>
        reported.push({ error, phase: context.phase }),
    });

    const failure = await handle.ready.then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProvideFailedError);
    expect((failure as ProvideFailedError)._tag).toBe("provide_failed");
    expect((failure as ProvideFailedError).provider).toBe("db");
    // Whatever DID acquire was released before the failure surfaced.
    expect(trace).toEqual(["acquire:config", "release:config"]);
    expect(reported).toEqual([{ error: failure, phase: "provide" }]);

    await handle.stop();
  });

  // A boot failure AFTER the graph opened is the other half of the same
  // symmetry (#185): `open()` unwinds its own acquire half, so a later boot step
  // has to unwind the whole graph before `ready` rejects. Without it a host that
  // awaits `ready` and rethrows — the shape the scope how-to §3 shows — leaks
  // every provider until someone remembers to call `stop()`.
  it("releases the graph in reverse when `store.load()` throws after it opened", async () => {
    const trace: string[] = [];
    const store: Store<State> = {
      load: () => Promise.reject(new Error("disk gone")),
      save: () => Promise.resolve(),
      migrate: () => null,
    };

    const handle = run(dbMachine(), { ctx: dbGraph(trace), store });
    const failure = await handle.ready.then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toBe("disk gone");
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);

    // The rejection already ended the lifetime, so the `stop()` a careful host
    // still calls is a no-op — never a second release.
    await handle.stop();
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);
  });

  it("releases the graph in reverse when `store.migrate()` throws after it opened", async () => {
    const trace: string[] = [];
    const store: Store<State> = {
      load: () => Promise.resolve({ phase: "running", writes: 0 }),
      save: () => Promise.resolve(),
      migrate: () => {
        throw new Error("unreadable schema");
      },
    };

    const handle = run(dbMachine(), { ctx: dbGraph(trace), store });
    const failure = await handle.ready.then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toBe("unreadable schema");
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);

    await handle.stop();
    expect(trace.filter((line) => line.startsWith("release:"))).toEqual([
      "release:db",
      "release:config",
    ]);
  });

  it("routes a throwing release to `onError` without stranding its siblings", async () => {
    const trace: string[] = [];
    const reported: { phase: string; provider?: string }[] = [];
    const graph = provide({
      config: layer(
        () => ({ url: "postgres://test" }),
        () => {
          trace.push("release:config");
        },
      ),
      db: layer(
        ["config"],
        (_deps: { config: { url: string } }): Db => ({
          url: "x",
          rows: [],
          open: true,
        }),
        () => {
          throw new Error("close failed");
        },
      ),
    });

    const handle = run(dbMachine(), {
      ctx: graph,
      onError: (_error, context) =>
        reported.push({ phase: context.phase, provider: context.provider }),
    });
    await handle.ready;
    await handle.stop();

    expect(trace).toEqual(["release:config"]);
    expect(reported).toEqual([{ phase: "provide", provider: "db" }]);
  });
});

describe("run(ctx: provide(…)) — the journal never sees a provider", () => {
  it("writes a byte-identical journal to the same run on a hand-built ctx", async () => {
    const msgs: Msg[] = [
      { type: "write" },
      { type: "write" },
      { type: "finish" },
    ];

    // The transcript a journal is: every applied Msg and the State it landed on,
    // plus every byte the store was handed.
    async function journalOf(useProvide: boolean): Promise<string> {
      const saved: string[] = [];
      const applied: unknown[] = [];
      const store = memoryStore<State>(null);
      const recording = {
        ...store,
        async save(state: State): Promise<void> {
          saved.push(JSON.stringify(state));
          await store.save(state);
        },
      };
      const db: Db = { url: "postgres://test", rows: [], open: true };
      const handle = run(dbMachine(), {
        store: recording,
        ctx: useProvide
          ? provide({ db: value(db) })
          : ({ db } as unknown as { db: Db }),
      });
      const rt = await handle.ready;
      rt.observe((msg, state) => applied.push([msg, state]));
      for (const msg of msgs) await rt.dispatch(msg);
      await rt.stop();
      return JSON.stringify({ saved, applied });
    }

    expect(await journalOf(true)).toBe(await journalOf(false));
  });

  it("replays the journal without ever invoking an acquire", async () => {
    const acquire = vi.fn(
      (): Db => ({ url: "postgres://test", rows: [], open: true }),
    );
    const graph = provide({ db: layer(acquire) });

    const scope = await graph.open();
    acquire.mockClear();

    // Replay is a fold over Msgs: it calls no interpret handler, so it reaches
    // no provider. The `ctx` it takes is the ALREADY-BUILT one — a graph is not
    // a `ctx` and `replay` has no boot to open one in.
    const folded = replay(dbMachine(), {
      ctx: scope.ctx,
      msgs: [{ type: "write" }, { type: "finish" }] as Msg[],
    });

    expect(folded.state).toEqual({ phase: "done", writes: 1 });
    expect(acquire).not.toHaveBeenCalled();
    // The interpret handler never ran, so the provided handle was never touched.
    expect(scope.ctx.db.rows).toEqual([]);
    await scope.release();
  });
});

// ── The same API under every host adapter. ──────────────────────────────────
//
// `/node`, `/do` and `/mem` are `Store<S>` adapters; the provider graph sits at
// `run`'s `ctx` seam, which all three share. These pin that the seam really is
// shared — one graph, one `run` call shape, three stores.

describe("run(ctx: provide(…)) — under /mem, /node and /do", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tea-provide-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const parse = (raw: unknown): State | null =>
    typeof raw === "object" && raw !== null && "phase" in raw
      ? (raw as State)
      : null;

  function fakeDoStorage() {
    const backing = new Map<string, string>();
    return {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        return backing.get(key) as T | undefined;
      },
      async put<T>(key: string, v: T): Promise<void> {
        backing.set(key, v as unknown as string);
      },
    } as unknown as DurableObjectStorage;
  }

  it.each([
    ["mem", () => memoryStore<State>(null)],
    ["node", () => fileStore<State>(join(dir, "state.json"), parse)],
    ["do", () => doStore<State>(fakeDoStorage(), parse)],
  ])("acquires and releases the same graph under /%s", async (_host, make) => {
    const trace: string[] = [];
    const state = await driveToDone(
      run(dbMachine(), { store: make(), ctx: dbGraph(trace) }),
      { type: "finish" },
      isTerminal,
    );

    expect(state.phase).toBe("done");
    expect(trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);
  });
});
