/**
 * @packageDocumentation
 * The host-side provider graph — what satisfies a Cmd's `R` (Requirements)
 * channel.
 *
 * A `Cmd` is journaled data, so it can never carry a provider: a provider is a
 * closure, and a closure does not survive a `Store<S>` round-trip (ADR 0014).
 * The requirement it declares — `R` — is a TYPE, and a type needs no closure.
 * So the graph that SATISFIES it lives one layer out, in the host, where
 * closures are ordinary: `provide({ … })` builds the `ctx` object `run` already
 * takes, acquiring each provider once, in dependency order, and releasing them
 * in reverse when the run ends.
 *
 * The journal never sees any of this. Replay is a fold over Msgs (ADR 0014) and
 * a fold calls no handler, so it calls no `acquire`. The graph is host wiring —
 * hidden, per ADR 0015 — while the State it produced effects over stays visible.
 *
 * The contract is Effect's `Layer` + `Scope`, point for point, because that
 * shape has a decade of production behind it and inventing a fourth one here
 * would only be a fourth one to learn:
 *
 * 1. A provider is `acquire` plus an optional `release`; an `acquire` may depend
 *    on other providers.
 * 2. Built once per scope, in dependency order, MEMOIZED — a provider two others
 *    depend on is acquired exactly once.
 * 3. Released in reverse acquisition order, exactly once, on every terminal. A
 *    `release` that throws does not stop its siblings from running.
 * 4. An `acquire` failure releases whatever was already acquired, in reverse,
 *    then surfaces as a typed `ProvideFailedError` (ADR 0011) — never a throw
 *    that escapes `run`.
 *
 * ```ts
 * const scoped = provide({
 *   config: value({ url: "postgres://…" }),
 *   db: layer(
 *     ["config"],
 *     ({ config }: { config: { url: string } }) => connect(config.url),
 *     (db) => db.close(),
 *   ),
 * });
 *
 * // Either hand it straight to `run` — which acquires at boot and releases at
 * // `stop()` — or open it yourself when the host wires its own `ctx`.
 * const state = await driveToDone(run(machine, { ctx: scoped }), start, isDone);
 * ```
 */

/**
 * Brand marking a {@link Provided} graph apart from a hand-built `ctx`. Symbol
 * keyed and module-private, so it reaches no export and no `ctx` object can
 * collide with it by accident.
 */
const providedBrand: unique symbol = Symbol("demlik-tea.provided");

/**
 * One node of the graph: an `acquire`, an optional `release`, and the names of
 * the sibling providers `acquire` reads.
 *
 * `D` is the shape `acquire` receives — a record of the resolved values of
 * {@link Provider.deps}. Build one with {@link layer} or {@link value} rather
 * than by hand; the constructors are what keep `deps` and `D` in step.
 *
 * `K` is the dependency NAME set — the keys `deps` may spell. {@link layer}
 * infers it from the literal you pass, and {@link provide} constrains it to the
 * map's own keys, so a misspelled dependency is a compile error at the call site
 * rather than an {@link UnknownProviderError} at `open()`. It defaults to
 * `string`, which is the untyped reading: a `Provider<T, D>` written by hand
 * still names its deps with plain strings, and only the map it is passed to
 * narrows them.
 */
export interface Provider<
  T,
  D = Record<never, never>,
  K extends string = string,
> {
  /** Names of the sibling providers `acquire` reads, resolved before it runs. */
  readonly deps: readonly K[];
  /**
   * Build the value. May be async; may read its declared `deps`.
   *
   * A function-typed PROPERTY, not a method: a method's parameters are
   * bivariant, and bivariance here would silently accept a provider whose deps
   * disagree with the map's — the one check `provide` exists to make.
   */
  readonly acquire: (deps: D) => T | Promise<T>;
  /**
   * Tear the value down. Optional — a provider with no `release` is a value with
   * no lifetime. May be async; the scope awaits it.
   *
   * A METHOD, unlike `acquire`: its parameter is this provider's OWN value, so
   * there is no sibling to cross-check and the bivariance a method's parameters
   * get is what lets a `Provider<Db, …>` be read through the erased
   * `Provider<unknown, …>` the map's constraint spells.
   */
  release?(value: T): unknown;
}

/** A provider whose value and dep shape are erased — the map's element type. */
type AnyProvider = Provider<unknown, never, string>;

/**
 * The `ctx` a provider map produces: each key mapped to its provider's value.
 */
export type ProvidedCtx<M> = {
  [K in keyof M]: M[K] extends Provider<infer T, never, string> ? T : never;
};

/**
 * A provider with no dependencies — {@link layer}'s one-argument form and
 * {@link value}. Its `K` is `never`, so an empty `deps` fits EVERY map: a
 * leaf provider is admissible wherever it is declared, whatever keys the map
 * around it happens to have.
 */
type LeafProvider<T> = Provider<T, Record<never, never>, never>;

/**
 * A live scope — the `ctx` its graph produced, plus the one call that tears it
 * down. `release` is idempotent: the second call is a no-op, so a host that
 * releases in a `finally` beside a `run` that already released cannot double-free.
 */
export interface Scope<Ctx> {
  /** The built `ctx`, one field per provider. */
  readonly ctx: Ctx;
  /**
   * Release every acquired provider in reverse acquisition order, exactly once.
   * Each `release` is isolated: a throw is routed to `onReleaseError` and the
   * remaining releases still run. Never rejects.
   */
  release(): Promise<void>;
}

/**
 * Sink for a `release` that threw. A release failure has no caller to reject at
 * — the run is already over — so it is reported, never propagated.
 */
export type OnReleaseError = (error: unknown, provider: string) => void;

/**
 * An unopened provider graph. Pass it to `run` as `ctx` (it acquires at boot and
 * releases at `stop()`), or {@link Provided.open} it yourself when the host
 * wires its own `ctx`.
 */
export interface Provided<Ctx> {
  /** Brand — see the module note. Never assigned by a consumer. */
  readonly [providedBrand]: true;
  /**
   * Acquire the whole graph and return the live {@link Scope}. Rejects with a
   * {@link ProvideFailedError} when an `acquire` fails, having already released
   * everything it had acquired, in reverse.
   */
  open(onReleaseError?: OnReleaseError): Promise<Scope<Ctx>>;
}

/**
 * An `acquire` failed. A typed failure (ADR 0011) rather than the raw throw:
 * `provider` names the node that failed and `cause` carries what it threw, so a
 * host reads which dependency the run could not stand up without matching on a
 * message.
 *
 * By the time this is raised, every provider acquired before it has been
 * released in reverse.
 */
export class ProvideFailedError extends Error {
  readonly _tag = "provide_failed" as const;
  /** The provider key whose `acquire` failed. */
  readonly provider: string;
  constructor(provider: string, cause: unknown) {
    super(
      `@demlik/tea: provider ${JSON.stringify(provider)} failed to acquire`,
      { cause },
    );
    this.name = "ProvideFailedError";
    this.provider = provider;
  }
}

/**
 * A provider named a dependency the map has no key for. A contract breach
 * (ADR 0011) — the wiring itself is wrong, so it throws rather than settling.
 *
 * `provide` binds `deps` to `keyof M`, so a map it typechecked can never raise
 * this: the typo is a compile error at the call site instead. What is left is
 * the UNTYPED path — a map cast (`as never`, `as any`), assembled at runtime, or
 * read back through an erased `Provider<unknown, …>` — where there was no key
 * set to check against. The error stays because that path is real, not because
 * the typed one still needs it.
 */
export class UnknownProviderError extends Error {
  readonly _tag = "unknown_provider" as const;
  /** The missing key. */
  readonly provider: string;
  /** The provider that asked for it. */
  readonly requiredBy: string;
  constructor(provider: string, requiredBy: string) {
    super(
      `@demlik/tea: provider ${JSON.stringify(requiredBy)} depends on ${JSON.stringify(provider)}, which the provider map has no entry for`,
    );
    this.name = "UnknownProviderError";
    this.provider = provider;
    this.requiredBy = requiredBy;
  }
}

/**
 * The dependency graph has a cycle, so no acquisition order exists. A contract
 * breach (ADR 0011): the wiring is wrong and no run can fix it.
 */
export class ProviderCycleError extends Error {
  readonly _tag = "provider_cycle" as const;
  /** The cycle, in the order it was walked, closing on its own first key. */
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`@demlik/tea: provider dependency cycle — ${cycle.join(" → ")}`);
    this.name = "ProviderCycleError";
    this.cycle = cycle;
  }
}

/**
 * Declare a provider with no dependencies: an `acquire` and an optional
 * `release`.
 */
export function layer<T>(
  acquire: () => T | Promise<T>,
  release?: (value: T) => unknown,
): LeafProvider<T>;
/**
 * Declare a provider that depends on siblings. `deps` names them; `acquire`
 * receives their resolved values as a record, and the annotation you give that
 * parameter is what types `D`.
 *
 * The names are inferred as literals, not widened to `string`, so {@link provide}
 * can check them against the map's keys.
 */
export function layer<T, D, K extends string>(
  deps: readonly K[],
  acquire: (deps: D) => T | Promise<T>,
  release?: (value: T) => unknown,
): Provider<T, D, K>;
export function layer<T, D, K extends string>(
  first: readonly K[] | (() => T | Promise<T>),
  second?: ((deps: D) => T | Promise<T>) | ((value: T) => unknown),
  third?: (value: T) => unknown,
): Provider<T, D, K> {
  // The two forms are told apart by the FIRST argument's kind, never by arity:
  // `layer(acquire)` and `layer(deps, acquire)` are both length 1-or-2 at the
  // call site once a `release` is optional.
  if (typeof first === "function") {
    return {
      deps: [],
      acquire: first as (deps: D) => T | Promise<T>,
      release: second as ((value: T) => unknown) | undefined,
    };
  }
  return {
    deps: first,
    acquire: second as (deps: D) => T | Promise<T>,
    release: third,
  };
}

/**
 * Lift an already-built value into the graph — a provider with no `acquire` work
 * and no lifetime. The escape hatch for the config object, the clock, the
 * `fetch` you were handed: things a `ctx` carries that were never resources.
 */
export function value<T>(v: T): LeafProvider<T> {
  return { deps: [], acquire: () => v };
}

/**
 * Build an unopened provider graph from a map of providers.
 *
 * The map's own key set is the resulting `ctx`'s shape, and each provider is
 * checked against that shape on BOTH of its ends — so both halves of a wiring
 * mistake are a compile error here, not a surprise at 3 a.m.:
 *
 * - the `acquire` parameter, so a provider that reads `{ config: Config }`
 *   beside a `config` provider of some other type does not compile;
 * - the `deps` names, bound to `keyof M`, so `layer(["confg"], …)` does not
 *   compile either.
 *
 * Nothing is acquired until the graph is opened — by `run`, at boot, or by
 * {@link Provided.open}.
 */
export function provide<
  M extends {
    [K in keyof M]: Provider<unknown, ProvidedCtx<M>, Extract<keyof M, string>>;
  },
>(map: M): Provided<ProvidedCtx<M>> {
  // Snapshot the map's own keys once, in declaration order: that order is the
  // tie-break the topological walk falls back on, so two runs of one graph
  // acquire in the same order and a journal-parity test has something stable to
  // compare against.
  const keys = Object.keys(map);
  const nodes = map as unknown as Record<string, AnyProvider>;

  return {
    [providedBrand]: true,
    async open(
      onReleaseError: OnReleaseError = defaultOnReleaseError,
    ): Promise<Scope<ProvidedCtx<M>>> {
      const built = new Map<string, unknown>();
      // Acquisition order, oldest first. This is the ONLY record release walks,
      // so a provider that never finished acquiring is never released — the
      // acquire/release pairing is by construction, not by bookkeeping.
      const acquired: { key: string; provider: AnyProvider }[] = [];
      // The current dependency PATH, not the visited set: a key is added on the
      // way down and removed on the way back up, so re-entering one that is
      // still on the path is a cycle, while a diamond re-entering a FINISHED one
      // hits the memo above and is not.
      const path: string[] = [];

      async function build(key: string, requiredBy: string): Promise<unknown> {
        if (built.has(key)) return built.get(key);
        const provider = nodes[key];
        if (provider === undefined) {
          throw new UnknownProviderError(key, requiredBy);
        }
        if (path.includes(key)) {
          throw new ProviderCycleError([...path.slice(path.indexOf(key)), key]);
        }
        path.push(key);
        const deps: Record<string, unknown> = {};
        for (const dep of provider.deps) {
          deps[dep] = await build(dep, key);
        }
        let acquiredValue: unknown;
        try {
          acquiredValue = await provider.acquire(deps as never);
        } catch (error) {
          throw new ProvideFailedError(key, error);
        }
        path.pop();
        built.set(key, acquiredValue);
        acquired.push({ key, provider });
        return acquiredValue;
      }

      // Release the acquired prefix in reverse, isolated. The one teardown path:
      // both the acquire-failure unwind and the scope's own `release` call it,
      // so "reverse, exactly once, isolated" is written down once.
      let released = false;
      async function releaseAll(): Promise<void> {
        if (released) return;
        released = true;
        for (let i = acquired.length - 1; i >= 0; i--) {
          const entry = acquired[i];
          if (entry === undefined) continue;
          const { key, provider } = entry;
          const release = provider.release;
          if (release === undefined) continue;
          try {
            await release(built.get(key) as never);
          } catch (error) {
            onReleaseError(error, key);
          }
        }
      }

      try {
        for (const key of keys) await build(key, key);
      } catch (error) {
        // Unwind before surfacing: whatever DID acquire has a lifetime, and a
        // failed boot is exactly when nobody else will end it.
        await releaseAll();
        throw error;
      }

      const ctx = Object.fromEntries(
        keys.map((key) => [key, built.get(key)]),
      ) as ProvidedCtx<M>;
      return { ctx, release: releaseAll };
    },
  };
}

/** Is this `ctx` argument an unopened provider graph rather than a plain `ctx`? */
export function isProvided<Ctx>(
  candidate: Ctx | Provided<Ctx> | undefined,
): candidate is Provided<Ctx> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as Partial<Provided<Ctx>>)[providedBrand] === true
  );
}

// Absent sink → warn. A release throw is a real defect (a handle stayed open)
// but the run it belonged to is already over, so there is nothing left to fail:
// loud enough to be found, never fatal — the same reading `run`'s default
// `onError` gives a teardown notice.
function defaultOnReleaseError(error: unknown, provider: string): void {
  console.warn(
    `@demlik/tea: release of provider ${JSON.stringify(provider)} threw`,
    error,
  );
}
