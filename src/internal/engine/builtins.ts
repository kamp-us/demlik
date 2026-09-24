/**
 * tea's built-ins, each one an {@link Extension} of the core loop (`./loop`,
 * #280). None is a public plugin API (#268): each engine's `run` builds them
 * from its options through {@link builtinExtensions}, which fixes their order.
 */

import type { AnyCmdDef, Identity, Port } from "../../pure/core";
import {
  checkedStep,
  cmdContractOver,
  cmdEdge,
  lookupCell,
  NoCellError,
  Outcome,
  structuralHash,
} from "../../pure/core";
import type {
  Store,
  Supervision,
  TelemetryEvent,
  TelemetrySink,
} from "../../runtime-types";
import { IdentityDropNotice, isFencedStore } from "../../runtime-types";
import type { Extension, ExtensionFactory, LoopServices } from "./loop";

type AnyExtension<S, M, C> = ExtensionFactory<S, M, C>;

// === update middleware ===

/**
 * Supervision: a throw from the fold (the reducer, or any update middleware
 * inside this one) is reported under `"reduce"` for every strategy, then
 * `restart` commits the host's rehydrated State with no Cmds, `escalate`
 * rethrows with the runtime still live, and `stop` (the default) halts the gate
 * and rethrows, so THIS dispatch rejects too.
 *
 * A Msg the current State has no cell for is not a reducer throw — no machine
 * code ran, the caller dispatched something this State does not accept (#310).
 * Its `NoCellError` rejects only that dispatch and keeps the run alive under
 * every strategy: it is not reported under `"reduce"`, `restart` does not
 * rehydrate, and `stop` does not halt. The refusal stays loud; it just is not
 * the program's failure.
 */
export function supervision<S, M extends { type: string }, C>(
  declared: Supervision<S, M> | undefined,
  machine: CellTable,
): AnyExtension<S, M, C> {
  const policy =
    declared === undefined
      ? ({ strategy: "stop" } as const)
      : typeof declared === "string"
        ? ({ strategy: declared } as const)
        : declared;
  return (loop) => ({
    update: (next) => (state, msg) => {
      try {
        return next(state, msg);
      } catch (reduceError) {
        if (isRefusal(machine, reduceError, state, msg)) throw reduceError;
        loop.report(reduceError, "reduce");
        switch (policy.strategy) {
          case "restart":
            // A throw inside `rehydrate` is NOT caught — it reaches the caller.
            return [policy.rehydrate(state, msg, reduceError), []];
          case "escalate":
            throw reduceError;
          default:
            loop.halt();
            throw reduceError;
        }
      }
    },
  });
}

/** The part of a machine that says which cell a `(state, msg)` pair selects. */
type CellTable = Parameters<typeof lookupCell>[0];

/**
 * A `NoCellError` is a refusal only when the machine really has no cell for
 * this `(state, msg)`: then nothing ran, and the error is the lookup's own. A
 * `NoCellError` raised INSIDE a cell that does exist (a reducer stepping a
 * child machine by hand) is that reducer failing, and stays supervised.
 */
function isRefusal<S, M extends { type: string }>(
  machine: CellTable,
  error: unknown,
  state: S,
  msg: M,
): boolean {
  return (
    error instanceof NoCellError &&
    lookupCell(machine, state, msg).cell === undefined
  );
}

/**
 * The instance-identity filter: drop a Msg addressed to a DIFFERENT instance
 * than the one this State owns, before the reducer sees it. A Msg with no
 * identity, or a State that has none yet, always proceeds. The drop is no
 * transition, and it RESOLVES the dispatch — a mis-addressed Msg is not the
 * caller's error — so it is reported as an `IdentityDropNotice` (warn by
 * default) or the caller could not tell "applied" from "discarded".
 *
 * Sits INSIDE {@link supervision}, so a throwing `ofMsg` / `ofState` is reported
 * and supervised exactly like a reducer throw (spike #264 run 3).
 */
export function identityFilter<S, M extends { type: string }, C>(
  identity: Identity<S, M> | undefined,
): AnyExtension<S, M, C> {
  return (loop) => {
    if (identity === undefined) return {};
    const misaddressed = (msg: M, state: S): boolean => {
      const addressed = identity.ofMsg(msg);
      if (addressed === undefined) return false;
      const own = identity.ofState(state);
      if (own === undefined) return false;
      return structuralHash(addressed) !== structuralHash(own);
    };
    return {
      update: (next) => (state, msg) => {
        if (!misaddressed(msg, state)) return next(state, msg);
        loop.report(new IdentityDropNotice(msg.type), "identity-drop");
        return null;
      },
    };
  };
}

/**
 * The dev pre/post pair around the reducer (`checkedStep`): freeze the input
 * State so an in-place mutation trips, and check the returned `[state, cmds]`
 * shape. Both compile out of production. Innermost, so it sees exactly what the
 * reducer saw.
 */
export function devChecks<S, M extends { type: string }, C>(): AnyExtension<
  S,
  M,
  C
> {
  return () => ({
    update: (next) => (state, msg) => checkedStep(state, msg, next),
  });
}

// === interpret middleware ===

/**
 * The `Cmd.define` edge (ADR 0021): a defined Cmd's handler return is minted
 * into its `_ok` / `_err` Msg, its `ok` value parsed against the def's schema
 * and stamped with `at` from `clock`. A defined Cmd's handler failing outside
 * its declared channel goes to the sink under `"interpret"`; a hand-written
 * Cmd's handler throw keeps rejecting the dispatch.
 *
 * A defined Cmd's handler that DISPATCHES its own `_ok` / `_err`, built by hand
 * rather than minted by this edge, breaks the same contract as one that
 * returns it: the Msg is dropped and the `OutcomeContractError` goes to the
 * sink under `"interpret"`. Its other Msgs are delivered as before.
 *
 * The same edge rides on ctx under `cmdEdge`, beside the `ok` / `err` builders,
 * so a handler that runs a base handler inside its own settles the base's
 * outcome through this one edge (#66).
 */
export function cmdDefinitions<S, M extends { type: string }, C>(
  defs: readonly AnyCmdDef[],
  clock: () => number,
): AnyExtension<S, M, C> {
  return (loop) => {
    const { settle, checkDispatch: check } = cmdContractOver(defs, clock);
    const defined = new Set(defs.map((d) => d.cmdType));
    return {
      interpret: (next) => async (cmd, dispatch) => {
        const type = (cmd as { type: string }).type;
        const checked = defined.has(type)
          ? (msg: M) => {
              try {
                check(cmd as { type: string }, msg);
              } catch (err) {
                loop.report(err, "interpret");
                return;
              }
              dispatch(msg);
            }
          : dispatch;
        try {
          return settle(cmd as { type: string }, await next(cmd, checked));
        } catch (err) {
          if (!defined.has(type)) throw err;
          loop.report(err, "interpret");
          return undefined;
        }
      },
      ctx: { ok: Outcome.ok, err: Outcome.err, [cmdEdge]: settle },
    };
  };
}

// === store wrapper ===

/**
 * Fencing is a property of the store the caller handed `run`, never a flag
 * (#143). A fenced store is read with its version at boot and every save is a
 * compare-and-swap against the last version this run saw, so a second writer
 * that took over is refused with `StoreConflictError` at this run's next save —
 * before that transition's Cmds run. A plain store passes through unchanged.
 */
export function fencing<S, M, C>(): AnyExtension<S, M, C> {
  return () => ({
    store: (store: Store<S>): Store<S> => {
      if (!isFencedStore(store)) return store;
      let version = 0;
      return {
        async load() {
          const read = await store.loadFenced();
          version = read.version;
          return read.raw;
        },
        async save(state) {
          version = await store.saveFenced(state, version);
        },
        migrate: (raw) => store.migrate(raw),
      };
    },
  });
}

// === ctx + handle: ports ===

/**
 * Ports (`definePort`): `ctx.emit(port, value)` from a handler and
 * `emitPort` / `subscribePort` on the handle. Fanout is synchronous and
 * throw-isolated under `"port-emit"`; no subscribers is a no-op.
 */
export function ports<S, M, C>(): AnyExtension<S, M, C> {
  return (loop) => {
    const registry = new Map<Port<unknown>, Set<(value: unknown) => void>>();
    function emit<T>(port: Port<T>, value: T): void {
      const subscribers = registry.get(port as Port<unknown>);
      if (!subscribers || subscribers.size === 0) return;
      loop.fanout(subscribers, "port-emit", (listener) => listener(value));
    }
    return {
      ctx: { emit },
      handle: {
        subscribePort<T>(
          port: Port<T>,
          listener: (value: T) => void,
        ): () => void {
          const key = port as Port<unknown>;
          const bucket = registry.get(key) ?? new Set();
          registry.set(key, bucket);
          const erased = listener as (value: unknown) => void;
          bucket.add(erased);
          return () => {
            bucket.delete(erased);
            if (bucket.size === 0 && registry.get(key) === bucket)
              registry.delete(key);
          };
        },
        emitPort: emit,
      },
    };
  };
}

// === commit observers ===

/**
 * `subscribe` (zero-arg change notifiers), then `observe` (every applied
 * transition's `(msg, state)`) or, at boot, `onBoot` (the initial State, once;
 * a handler registered after boot fires at once). Each fanout is
 * throw-isolated under its own phase.
 */
export function observation<S, M, C>(): AnyExtension<S, M, C> {
  return (loop) => {
    const listeners = new Set<() => void>();
    const observers = new Set<(msg: M, state: S) => void>();
    const bootHandlers = new Set<(state: S) => void>();
    let booted = false;
    return {
      commit(msg, state) {
        loop.fanout(listeners, "listener", (listener) => listener());
        if (msg === undefined) {
          booted = true;
          loop.fanout(bootHandlers, "boot", (handler) => handler(state));
          return;
        }
        loop.fanout(observers, "observer", (observer) => observer(msg, state));
      },
      handle: {
        subscribe: subscribeTo(listeners),
        observe: subscribeTo(observers),
        onBoot(handler: (state: S) => void): () => void {
          const state = loop.state();
          if (booted && state !== undefined) {
            loop.fanout([handler], "boot", (h) => h(state));
            return () => {};
          }
          return subscribeTo(bootHandlers)(handler);
        },
      },
    };
  };
}

function subscribeTo<T>(set: Set<T>): (item: T) => () => void {
  return (item) => {
    set.add(item);
    return () => {
      set.delete(item);
    };
  };
}

/**
 * The semantic event channel: `project` maps each APPLIED transition to zero or
 * more public events, and `on(type, handler)` receives only its own type. The
 * machine's private Msg names never reach `on`. A throw in the projector or a
 * handler is isolated under `"event"`. Boot projects nothing.
 */
export function semanticEvents<S, M, C, E extends { type: string }>(
  project: ((msg: M, state: S) => readonly E[]) | undefined,
): AnyExtension<S, M, C> {
  return (loop) => {
    const handlers = new Map<string, Set<(event: E) => void>>();
    return {
      commit(msg, state) {
        if (msg === undefined || project === undefined || handlers.size === 0)
          return;
        let events: readonly E[];
        try {
          events = project(msg, state);
        } catch (err) {
          loop.report(err, "event");
          return;
        }
        for (const event of events) {
          const bucket = handlers.get(event.type);
          if (bucket === undefined) continue;
          loop.fanout(bucket, "event", (handler) => handler(event));
        }
      },
      handle: {
        on(type: string, handler: (event: E) => void): () => void {
          const bucket = handlers.get(type) ?? new Set();
          handlers.set(type, bucket);
          bucket.add(handler);
          return () => {
            bucket.delete(handler);
            if (bucket.size === 0 && handlers.get(type) === bucket)
              handlers.delete(type);
          };
        },
      },
    };
  };
}

/**
 * Run terminality: `result()` reads the State when `isTerminal` holds for it,
 * and `done()` resolves on the first commit (boot included — a rehydrated run
 * can land terminal) where it does. No predicate → never terminal.
 */
export function terminality<S, M, C>(
  isTerminal: ((state: S) => boolean) | undefined,
): AnyExtension<S, M, C> {
  const holds = isTerminal ?? (() => false);
  return (loop) => {
    const waiters = new Set<(state: S) => void>();
    return {
      commit(_msg, state) {
        if (waiters.size === 0 || !holds(state)) return;
        const parked = [...waiters];
        waiters.clear();
        for (const resolve of parked) resolve(state);
      },
      handle: {
        result(): S | undefined {
          const current = loop.state() as S;
          return holds(current) ? current : undefined;
        },
        done(): Promise<S> {
          const current = loop.state() as S;
          if (holds(current)) return Promise.resolve(current);
          return new Promise<S>((resolve) => {
            waiters.add(resolve);
          });
        },
      },
    };
  };
}

/**
 * Telemetry (#268: `withTelemetry` moved inside tea). Every applied transition
 * hands the sink `{ seq, msgType, at }` — `seq` counts this run's applied
 * transitions from 1, `at` reads `clock`. Fire-and-forget: the loop never waits
 * on the sink, and a sink that throws or rejects reaches `onError` under
 * `"observer"` without touching the run.
 */
export function telemetry<S, M extends { type: string }, C>(
  sink: TelemetrySink | undefined,
  clock: () => number,
): AnyExtension<S, M, C> {
  return (loop: LoopServices<S>): Extension<S, M, C> => {
    if (sink === undefined) return {};
    let seq = 0;
    return {
      commit(msg) {
        if (msg === undefined) return;
        seq += 1;
        const event: TelemetryEvent = { seq, msgType: msg.type, at: clock() };
        try {
          Promise.resolve(sink(event)).catch((err: unknown) =>
            loop.report(err, "observer"),
          );
        } catch (err) {
          loop.report(err, "observer");
        }
      },
    };
  };
}

// === assembly: the one order both engines run the built-ins in ===

/** The `run` options the built-ins read. Every engine's `run` accepts them. */
export interface BuiltinOptions<
  S,
  M extends { type: string },
  E extends { type: string },
> {
  readonly clock?: () => number;
  readonly events?: (msg: M, state: S) => readonly E[];
  readonly supervision?: Supervision<S, M>;
  readonly terminal?: (state: S) => boolean;
  readonly telemetry?: TelemetrySink;
}

/**
 * The built-ins, in the one order that gives them their meaning. Every engine
 * builds its loop from this list, so a machine means the same thing on each.
 *
 * Update middleware nests first-outermost: supervision wraps the identity
 * filter (a throwing `ofMsg` is supervised like a reducer throw — spike #264
 * run 3), which wraps the dev checks around the reducer itself. A Msg with no
 * cell rejects through supervision unsupervised (#310). Commit
 * callbacks run in order: change listeners, then `observe` / `onBoot`, then
 * semantic events, then `done()` waiters, then telemetry.
 */
export function builtinExtensions<
  S,
  M extends { type: string },
  C,
  E extends { type: string },
>(
  machine: CellTable & {
    readonly identity?: Identity<S, M>;
    readonly cmds?: readonly AnyCmdDef[];
  },
  opts: BuiltinOptions<S, M, E>,
): readonly ExtensionFactory<S, M, C>[] {
  const clock = opts.clock ?? Date.now;
  return [
    supervision(opts.supervision, machine),
    identityFilter(machine.identity),
    devChecks(),
    cmdDefinitions(machine.cmds ?? [], clock),
    fencing(),
    ports(),
    observation(),
    semanticEvents(opts.events),
    terminality(opts.terminal),
    telemetry(opts.telemetry, clock),
  ];
}
