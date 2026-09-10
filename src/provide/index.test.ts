import { describe, expect, it, vi } from "vitest";
import {
  layer,
  ProvideFailedError,
  ProviderCycleError,
  provide,
  UnknownProviderError,
  value,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// The host-side provider graph (#183). Effect's `Layer` + `Scope` contract,
// point for point: dependency order, memoization, reverse release exactly once,
// isolated release throws, and an acquire failure that unwinds what it built
// before surfacing as a typed failure.
//
// Everything here is the GRAPH alone — no `run`. The run-level half (acquire at
// boot, release on done / failed / cancelled, journal parity) lives in
// `src/provide-run.test.ts`.
// ───────────────────────────────────────────────────────────────────────────

/** A trace of `acquire:<key>` / `release:<key>` in the order they happened. */
function tracer() {
  const trace: string[] = [];
  return {
    trace,
    acquire: (key: string) => () => {
      trace.push(`acquire:${key}`);
      return key;
    },
    release: (key: string) => () => {
      trace.push(`release:${key}`);
    },
  };
}

describe("provide — build order and memoization", () => {
  it("acquires in dependency order, dependencies first", async () => {
    const t = tracer();
    // Declared leaf-last on purpose: the ORDER that matters is the dependency
    // one, not the one the object literal happens to spell.
    const graph = provide({
      app: layer(["db"], (_deps: { db: string }) => t.acquire("app")()),
      db: layer(["config"], (_deps: { config: string }) => t.acquire("db")()),
      config: layer(t.acquire("config")),
    });

    const scope = await graph.open();

    expect(t.trace).toEqual(["acquire:config", "acquire:db", "acquire:app"]);
    expect(scope.ctx).toEqual({ app: "app", db: "db", config: "config" });
  });

  it("acquires a shared provider exactly once (the diamond)", async () => {
    const acquireConfig = vi.fn(() => ({ url: "postgres://x" }));
    type Config = { url: string };

    const graph = provide({
      config: layer(acquireConfig),
      db: layer(
        ["config"],
        (deps: { config: Config }) => `db@${deps.config.url}`,
      ),
      cache: layer(
        ["config"],
        (deps: { config: Config }) => `cache@${deps.config.url}`,
      ),
    });

    const scope = await graph.open();

    expect(acquireConfig).toHaveBeenCalledTimes(1);
    expect(scope.ctx.db).toBe("db@postgres://x");
    expect(scope.ctx.cache).toBe("cache@postgres://x");
    // One acquisition means ONE value — the two dependents hold the same object,
    // not two structurally-equal copies.
    expect(scope.ctx.db).toContain(scope.ctx.config.url);
  });

  it("lifts an already-built value with `value`, which has no lifetime", async () => {
    const clock = () => 42;
    const scope = await provide({ clock: value(clock) }).open();
    expect(scope.ctx.clock()).toBe(42);
    await expect(scope.release()).resolves.toBeUndefined();
  });
});

describe("provide — release", () => {
  it("releases in REVERSE acquisition order", async () => {
    const t = tracer();
    const scope = await provide({
      config: layer(t.acquire("config"), t.release("config")),
      db: layer(
        ["config"],
        (_deps: { config: string }) => t.acquire("db")(),
        t.release("db"),
      ),
    }).open();

    t.trace.length = 0;
    await scope.release();

    expect(t.trace).toEqual(["release:db", "release:config"]);
  });

  it("releases exactly once however many times it is called", async () => {
    const release = vi.fn();
    const scope = await provide({ db: layer(() => "db", release) }).open();

    await scope.release();
    await scope.release();
    await scope.release();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps running the remaining releases when one throws", async () => {
    const t = tracer();
    const onReleaseError = vi.fn();
    const boom = new Error("close failed");

    const scope = await provide({
      config: layer(t.acquire("config"), t.release("config")),
      db: layer(
        ["config"],
        (_deps: { config: string }) => t.acquire("db")(),
        () => {
          throw boom;
        },
      ),
    }).open(onReleaseError);

    t.trace.length = 0;
    await scope.release();

    // `db` released first and threw; `config` still released.
    expect(t.trace).toEqual(["release:config"]);
    expect(onReleaseError).toHaveBeenCalledWith(boom, "db");
  });

  it("awaits an async release before resolving", async () => {
    let closed = false;
    const scope = await provide({
      db: layer(
        () => "db",
        async () => {
          await Promise.resolve();
          closed = true;
        },
      ),
    }).open();

    await scope.release();
    expect(closed).toBe(true);
  });
});

describe("provide — acquire failure", () => {
  it("releases the already-acquired prefix in reverse, then surfaces typed", async () => {
    const t = tracer();
    const cause = new Error("connection refused");

    const graph = provide({
      config: layer(t.acquire("config"), t.release("config")),
      db: layer(
        ["config"],
        (_deps: { config: string }) => t.acquire("db")(),
        t.release("db"),
      ),
      broker: layer(["db"], (_deps: { db: string }) => {
        throw cause;
      }),
    });

    const failure = await graph
      .open(() => {})
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ProvideFailedError);
    expect((failure as ProvideFailedError)._tag).toBe("provide_failed");
    expect((failure as ProvideFailedError).provider).toBe("broker");
    expect((failure as ProvideFailedError).cause).toBe(cause);
    expect(t.trace).toEqual([
      "acquire:config",
      "acquire:db",
      "release:db",
      "release:config",
    ]);
  });

  it("never releases a provider that did not finish acquiring", async () => {
    const release = vi.fn();
    const graph = provide({
      db: layer(() => {
        throw new Error("nope");
      }, release),
    });

    await expect(graph.open(() => {})).rejects.toBeInstanceOf(
      ProvideFailedError,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("still runs the remaining unwinds when one of them throws", async () => {
    const t = tracer();
    const onReleaseError = vi.fn();

    const graph = provide({
      config: layer(t.acquire("config"), t.release("config")),
      db: layer(
        ["config"],
        (_deps: { config: string }) => t.acquire("db")(),
        () => {
          throw new Error("close failed");
        },
      ),
      broker: layer(["db"], (_deps: { db: string }) => {
        throw new Error("connection refused");
      }),
    });

    await expect(graph.open(onReleaseError)).rejects.toBeInstanceOf(
      ProvideFailedError,
    );
    expect(t.trace).toContain("release:config");
    expect(onReleaseError).toHaveBeenCalledTimes(1);
  });
});

describe("provide — wiring that cannot stand up (contract breaches)", () => {
  it("throws `UnknownProviderError` naming both ends of the missing edge", async () => {
    const graph = provide({
      // `secrets` is not a key of this map — the wiring itself is wrong.
      db: layer(["secrets"], (_deps: { secrets: string }) => "db"),
    } as never);

    const failure = await graph.open().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UnknownProviderError);
    expect((failure as UnknownProviderError).provider).toBe("secrets");
    expect((failure as UnknownProviderError).requiredBy).toBe("db");
  });

  it("throws `ProviderCycleError` naming the cycle it walked", async () => {
    const graph = provide({
      a: layer(["b"], (_deps: { b: string }) => "a"),
      b: layer(["a"], (_deps: { a: string }) => "b"),
    } as never);

    const failure = await graph.open().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProviderCycleError);
    expect((failure as ProviderCycleError).cycle).toEqual(["a", "b", "a"]);
  });
});
