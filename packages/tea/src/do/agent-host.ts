/**
 * `createAgentHost` — the runtime+events+autoBoot assembly + the test seam,
 * ONCE (issue #53). The facade over the concern modules: the deferred gateway
 * (`./deferred-gateway`), the WS carrier (`./command-socket`), the SSE plumbing
 * (`./sse`), and the cold-wake resume (`./resume`). See `./host` for the
 * transport-model rationale.
 */

import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentState,
  type AgentStatus,
  type AgentTurn,
  agentEvents,
  status,
} from "../agent/index";
import type {
  BootedRunHandle,
  Cmd,
  CtxArg,
  EngineRun,
  RunHandle,
  RunOptions,
  Store,
  StoreAndOnError,
  Sub,
  Tagged,
  Wired,
} from "../index";
import {
  defaultOnError,
  RuntimeStoppedError,
  sinkOrDefault,
} from "../internal/engine/loop";
import { DispatchDiscardedError } from "../runtime-types";
import {
  type Deferred,
  deferred,
  type HostCmd,
  type HostMsg,
  HostOverlapError,
  type HostPhase,
  hostLifecycle,
  stepLifecycle,
} from "./host-lifecycle";
import { agentBootPort, beginResume } from "./resume";
import { type SseHub, sseFromAgentEvents, sseHub } from "./sse";

// ─────────────────────────────────────────────────────────────────────────────
// createAgentHost — the runtime+events+autoBoot assembly + the test seam, ONCE
// (issue #53).
//
// Every DO that drives a `createAgent` runtime hand-rolls the SAME ordered
// wiring inside its `getRuntime()`: build the machine → `doStore` → `run(...)`
// with `terminal` + `events: agentEvents()` → wire `sseFromAgentEvents` →
// `autoBoot` → `await ready` → cache. And every one re-exposes the SAME
// framework test surface as public methods (`isSuspended` / `runPhase` /
// `verdict` / `settle`). The concern modules (`deferredGateway`, `autoBoot`,
// `sseFromAgentEvents`, …) already lift each STEP; this lifts the ASSEMBLY.
//
// `createAgentHost(config)` owns:
//   - the lazy build-once-boot-once runtime cell (the `if (this.runtime) return`
//     dance + the `await booting.ready` gate),
//   - the `events: agentEvents()` wiring + `sseFromAgentEvents(runtime, hub, …)`
//     so SSE is driven off the SEMANTIC `AgentEvent` stream, never the private
//     Msg firehose,
//   - the `agent_boot` re-fire on a rehydrated running or suspended run,
//   - the SSE hub (so `host.sse.open()` / `host.sse.register(...)` is the route +
//     the test seam), and
//   - the framework test/lifecycle seam ONCE: `status()`, `result()`, `reset()`.
//
// The consumer supplies ONLY its mappings: the engine's `run`, how to build the
// machine, the Store, the Ctx, the terminal predicate, and the `AgentEvent → SSE frame` projection.
// Its `getRuntime()` collapses to `host.runtime()`; its `isSuspended` /
// `runPhase` / `verdict` collapse to reads off `host.status()` / `host.result()`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the consumer supplies to {@link createAgentHost} — the domain mappings,
 * nothing of the wiring. `Stage`/`P`/`O`/`R` are the agent slice's type
 * parameters (the consumer names them once); `Frame` is its SSE event shape.
 * `C`/`U`/`Ctx` are the machine's own Cmd/Sub/Ctx — inferred from
 * `buildMachine` at the `createAgentHost` call site (never name them by hand;
 * an erased `any` here cost consumers all checking on this layer — #278).
 *
 * `M` carries the machine's message union, including registered tools' settle
 * messages. The wired machine must accept `AgentMachineMsg<P, O, R> | M`,
 * so the host can always send the agent protocol. It defaults to that protocol.
 *
 * `store` is required, and a fenced one needs an `onError` (see
 * {@link StoreAndOnError}).
 */
export type AgentHostConfig<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
  Ctx = unknown,
  M extends Tagged = AgentMachineMsg<P, O, R>,
> = AgentHostWiring<Stage, P, O, R, Frame, C, U, Ctx, M> &
  StoreAndOnError<AgentState<Stage, P, O, R>> & {
    /** The durable `Store` for the agent slice (typically `doStore(storage, parse)`). */
    readonly store: Store<AgentState<Stage, P, O, R>>;
  };

/** The part of {@link AgentHostConfig} that is not the store and its sink. */
export interface AgentHostWiring<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
  Ctx = unknown,
  M extends Tagged = AgentMachineMsg<P, O, R>,
> {
  /**
   * The engine's `run` — `run` from `@demlik/tea/promise`, or any engine's. The
   * host imports no engine; it boots the machine through this. `NoInfer` keeps
   * the generic engine from widening the messages inferred from `buildMachine`.
   */
  readonly run: EngineRun<
    AgentState<Stage, P, O, R>,
    AgentMachineMsg<P, O, R> | NoInfer<M>,
    C,
    U,
    Ctx,
    AgentEvent<R>
  >;
  /**
   * Build the wired agent machine and the handlers it runs under — its
   * `interpret` table and `subscribe` runners (a machine carries none — #278,
   * #279). Called once per host build (per activation), AFTER the previous
   * runtime — if any — was torn down. The consumer wires its per-tool interpret
   * here, and `agent.toMachine({ toolInterpret })` already returns exactly this.
   */
  readonly buildMachine: () => Wired<
    AgentState<Stage, P, O, R>,
    AgentMachineMsg<P, O, R> | M,
    C,
    U,
    Ctx
  >;
  /** The plain Ctx the machine threads to its interpret cells. */
  readonly ctx: Ctx;
  /**
   * The run-terminality predicate (#46) — what makes `result()` first-class.
   * Defaults to the agent's own terminal phases (`done` / `failed`).
   */
  readonly terminal?: (state: AgentState<Stage, P, O, R>) => boolean;
  /**
   * Map one semantic {@link AgentEvent} to the consumer's SSE frame, or `null`
   * to skip it. This is the ONLY place the consumer touches the SSE seam — the
   * host owns the subscription wiring (`sseFromAgentEvents`) and the hub.
   */
  readonly toSseFrame: (event: AgentEvent<R>) => Frame | null;
  /** Clock injected for `autoBoot` (the host's only boot clock read). */
  readonly now?: () => number;
}

/**
 * The assembled host: the runtime handle + the SSE hub + the framework test seam,
 * owned ONCE. A DO holds one `AgentHost` and delegates to it; its own surface
 * shrinks to the domain (the gateway, the WS bridge, the command-send mapping).
 *
 * @typeParam Stage Pipeline stage type.
 * @typeParam P     Brain-call purposes.
 * @typeParam O     Per-purpose outputs (bound to {@link AgentTurn}).
 * @typeParam R     Tool result type.
 * @typeParam Frame The consumer's SSE event shape.
 * @typeParam M The machine's messages, combined with the required agent protocol.
 */
export interface AgentHost<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
  M extends Tagged = AgentMachineMsg<P, O, R>,
> {
  /**
   * Get (or build) the booted runtime. Build-once-boot-once: the first call
   * builds the machine, wires SSE off the semantic event stream, awaits the boot
   * gate, dispatches `agent_boot` for a rehydrated running or suspended run (one
   * that was waiting on its model call, its compaction or its tools), and caches
   * the booted handle; subsequent calls return the cached handle. The single
   * assembly every consumer used to hand-roll in `getRuntime()`.
   *
   * The call resolves once `agent_boot` is queued, not when the work it
   * re-fired is done. That work can wait on a tool whose result a driver has not
   * posted yet, and the driver reaches the run through this call, so waiting for
   * it would deadlock. Read how far the run got from `getState()`, `subscribe` or
   * `status()`.
   *
   * @throws {HostOverlapError} While a `reset()` is still stopping the run.
   */
  runtime(): Promise<
    BootedRunHandle<
      AgentState<Stage, P, O, R>,
      AgentMachineMsg<P, O, R> | M,
      AgentEvent<R>
    >
  >;
  /**
   * The agent's lifecycle status (#49) — the ONE typed channel a consumer reads
   * instead of re-deriving `run.phase` / `awaiting` by hand. Ensures the runtime
   * is built + boot-reconciled first. Replaces the per-consumer `isSuspended` /
   * `runPhase` test methods (read `status().kind`: `idle` / `running` /
   * `suspended` / `done` / `failed`). A hydrated DO that has not yet seen
   * `agent_start` reads `idle`, not `running` (#92).
   */
  status(): Promise<AgentStatus<Stage>>;
  /**
   * The run's terminal State (#46), or `undefined` while in flight. Read the
   * run's product off it (e.g. `result()?.output`). Replaces the per-consumer
   * `verdict` plumbing's source. Ensures the runtime is built first.
   */
  result(): Promise<AgentState<Stage, P, O, R> | undefined>;
  /**
   * The SSE hub — the route (`host.sse.open()`) AND the test seam
   * (`host.sse.register(sink)`). The host drives `hub.emit` off the semantic
   * event stream; the consumer never touches it except to open / register.
   */
  readonly sse: SseHub<Frame>;
  /**
   * Tear down the cached runtime (drain its tail via `stop()`, up to
   * `disposeTimeoutMs`, then drop the handle) so the next `runtime()` rebuilds
   * from storage. A Cmd handler that has not returned by the limit is given up
   * on, so `reset()` returns either way, including while the run is waiting on a
   * tool nobody has answered. It stops the handle the host holds from the moment
   * `run` returned it, so it also stops a build that has not finished booting:
   * that build dispatches nothing more, and a `runtime()` still waiting on it
   * rejects with a `DispatchDiscardedError`.
   *
   * The framework `settle` test seam, owned once: a test and lifecycle seam for
   * one caller at a time, not the way to stop a run in production. Give `run`
   * a `cancellation` signal and abort it for that, and await a `reset()` before
   * the next `reset()` or `runtime()`.
   *
   * @throws {HostOverlapError} A `reset()` while another `reset()` is still
   * stopping the run, or from inside `run()`, and a `runtime()` while a
   * `reset()` is still stopping the run.
   */
  reset(): Promise<void>;
}

/**
 * Build an {@link AgentHost} from the consumer's domain mappings. Owns the
 * runtime+events+autoBoot assembly and the framework test seam — the wiring
 * issue #53 had every consumer re-write.
 *
 * @example
 * ```ts
 * import type { Interpret, Migrated } from "@demlik/tea";
 * import type {
 *   AgentKnob,
 *   AgentMachineMsg,
 *   AgentState,
 *   AgentTurn,
 *   ToolCall,
 * } from "@demlik/tea/agent";
 * import { createAgentHost, doStore } from "@demlik/tea/do";
 * import { run } from "@demlik/tea/promise";
 *
 * type Stage = "plan" | "act";
 * type Purpose = "plan_turn" | "act_turn";
 * type Outputs = Record<Purpose, AgentTurn>;
 * type ClientResult = string;
 * type ToolCmd = { readonly _tag: "run_tool" } & ToolCall;
 * type SseEvent =
 *   | { kind: "result"; callId: string; result: ClientResult }
 *   | { kind: "verdict"; verdict: string }
 *   | { kind: "phase"; phase: string };
 * interface Ctx { readonly apiKey: string }
 * type S = AgentState<Stage, Purpose, Outputs, ClientResult>;
 *
 * // From `createAgent(...)`, and the interpret for its tool Cmd.
 * declare const agent: AgentKnob<Stage, Purpose, Outputs, ClientResult, ToolCmd, false, false>;
 * declare const toolInterpret: Interpret<AgentMachineMsg<Purpose, Outputs, ClientResult>, ToolCmd, Ctx>;
 * declare const storage: DurableObjectStorage;
 * declare const parse: (raw: unknown) => Migrated<S>;
 * declare const ctx: Ctx;
 *
 * const host = createAgentHost({
 *   run,
 *   buildMachine: () => agent.toMachine<Ctx>({ toolInterpret }),
 *   store: doStore(storage, parse),
 *   ctx,
 *   toSseFrame: (e): SseEvent | null =>
 *     e._tag === "ToolSettled" ? { kind: "result", callId: e.callId, result: e.result } :
 *     e._tag === "TurnSettled" && e.turn.toolCalls.length === 0
 *       ? { kind: "verdict", verdict: e.turn.content } :
 *     e._tag === "RunDone" ? { kind: "phase", phase: e.status.kind } : null,
 * });
 * // route:
 * const sseRoute = (): Response => host.sse.open();
 * // start:
 * await (await host.runtime()).dispatch({ _tag: "agent_start", runId: "run-1", at: Date.now() });
 * // test:
 * const suspended = (await host.status()).kind === "suspended";
 * ```
 */
export function createAgentHost<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
  Ctx = unknown,
  M extends Tagged = AgentMachineMsg<P, O, R>,
>(
  config: AgentHostConfig<Stage, P, O, R, Frame, C, U, Ctx, M>,
): AgentHost<Stage, P, O, R, Frame, M> {
  type S = AgentState<Stage, P, O, R>;
  type Msg = AgentMachineMsg<P, O, R> | M;
  type E = AgentEvent<R>;

  const sse = sseHub<Frame>();
  const now = config.now ?? Date.now;
  // Every terminal phase, `cancelled` included: a run stopped from outside has
  // ended, so `done()` must resolve on it rather than wait for a `done` that is
  // not coming.
  const isTerminal =
    config.terminal ??
    ((s: S) =>
      s.run.phase === "done" ||
      s.run.phase === "failed" ||
      s.run.phase === "cancelled");

  type Booted = BootedRunHandle<S, Msg, E>;
  // One build's record, made before the build runs. The handle lands the moment
  // `run` returns it, and until then the table refuses a `reset()`.
  interface Build {
    readonly abort: AbortController;
    handle: RunHandle<S, Msg, E> | null;
    readonly result: Deferred<Booted>;
  }
  const lifecycle = hostLifecycle<Build>();
  let phase: HostPhase<Build> = { _tag: "empty" };
  const fresh = (): Build => ({
    abort: new AbortController(),
    handle: null,
    result: deferred(),
  });
  const discarded = () =>
    new DispatchDiscardedError(agentBootPort().resumeMsg(now())._tag);

  // The phase is set before the Cmds run, so a Cmd that reenters the host (a
  // `reset()` from inside `run`) meets the phase the call chose, and the call
  // that started a build still answers from that build.
  function send(msg: HostMsg<Build>): HostPhase<Build> {
    const [next, cmds] = stepLifecycle(lifecycle, phase, msg);
    phase = next;
    for (const cmd of cmds) perform(cmd);
    return next;
  }

  function begin(record: Build): void {
    build(record).then(record.result.resolve, record.result.reject);
    record.result.promise.then(
      () => send({ _tag: "built", build: record }),
      () => send({ _tag: "failed", build: record }),
    );
  }

  function perform(cmd: HostCmd<Build>): void {
    switch (cmd._tag) {
      case "begin":
        begin(cmd.build);
        return;
      case "tearDown": {
        // Abort first: the stop makes the engine refuse the build's pending
        // work, and the build tells that teardown from a failure by the signal.
        cmd.build.abort.abort(discarded());
        const handle = cmd.build.handle;
        new Promise<void>((resolve) => resolve(handle?.stop())).then(
          cmd.done.resolve,
          cmd.done.reject,
        );
        const settled = () => send({ _tag: "tornDown" });
        cmd.done.promise.then(settled, settled);
        return;
      }
      case "refuse":
        throw new HostOverlapError(cmd.call, cmd.during);
      default:
        cmd satisfies never;
    }
  }

  async function build(mine: Build): Promise<Booted> {
    const { signal } = mine.abort;
    // `run()` hands back a `RunHandle` synchronously (#45). Wire the SEMANTIC
    // event projector (#47) so `runtime.on(...)` lights up, then drive the SSE
    // hub off that named stream (never the private-Msg firehose).
    const wired = config.buildMachine();
    // `ctx` goes in as its own `CtxArg<Ctx>`: over a generic `Ctx` that
    // conditional stays deferred, and tsc relates it only to itself, not to an
    // object that spreads the handlers beside it.
    const ctxArg = { ctx: config.ctx } as CtxArg<Ctx>;
    // Lifted out of `config`, `store` and `onError` no longer read as one
    // member of its union, so the options are read at `run`'s own parameter
    // type.
    const booting: RunHandle<S, Msg, E> = config.run(wired.machine, {
      ...wired,
      ...ctxArg,
      store: config.store,
      onError: config.onError,
      events: agentEvents<Stage, P, O, R>(),
    } as RunOptions<S, Msg, C, U, Ctx, E>);
    // Held from the moment `run` returns it, before any await, so `reset()`
    // can stop this run whatever its boot is waiting on. Until then the table
    // refuses a `reset()`: it came from inside `run`.
    mine.handle = booting;

    // SSE off the semantic stream. Subscriptions attach on the booting handle
    // (total before boot), so the hub catches every event from the first
    // transition. The cleanup is implicit: the host tears the whole runtime
    // down in `reset()`, dropping every subscription with it.
    sseFromAgentEvents(booting, sse, config.toSseFrame);

    // Re-fire the one outstanding operation (model call, compaction or tool
    // effects) IFF this wake rehydrated a running or suspended run (no-op on a
    // fresh DO). The gate opens once `agent_boot` is queued, not when the work
    // it re-fired is done: that work can be waiting on a tool the driver has
    // not answered, and the driver reaches the run through this very call.
    // `beginResume` reads the signal after the load, so a `reset()` during it
    // dispatches nothing into the stopped runtime. The chain then has no
    // caller to reject at, so its failure goes to `onError` under `"boot"`
    // (invariant 6) and is never dropped. It is teardown, and left out, only
    // when this build was reset AND the engine rejected with one of the values
    // it refuses work with once stopped: the engine already reported that.
    const resumed = await beginResume(booting, agentBootPort(), now, signal);
    resumed?.finished.catch((error: unknown) => {
      const teardown =
        signal.aborted &&
        (error instanceof DispatchDiscardedError ||
          error instanceof RuntimeStoppedError);
      if (teardown) return;
      sinkOrDefault(config.onError ?? defaultOnError, error, {
        phase: "boot",
      });
    });
    const ready = await booting.ready;
    signal.throwIfAborted();
    return ready;
  }

  // Every `runtime()` call offers the table a fresh record; the cell keeps it
  // only when it starts a build. Two calls in one wake share the one build
  // (#313). A call during a teardown is refused: it throws a `HostOverlapError`.
  function runtime(): Promise<Booted> {
    const chosen = send({ _tag: "runtime", fresh: fresh() });
    if (chosen._tag === "building" || chosen._tag === "live")
      return chosen.build.result.promise;
    throw new Error(`host lifecycle: runtime() left the host ${chosen._tag}`);
  }

  return {
    runtime,
    async status(): Promise<AgentStatus<Stage>> {
      return status((await runtime()).getState());
    },
    async result(): Promise<S | undefined> {
      // The terminal read, off the host's own predicate rather than an engine's
      // `result()` — the handle every engine returns does not carry one.
      const state = (await runtime()).getState();
      return isTerminal(state) ? state : undefined;
    },
    sse,
    reset(): Promise<void> {
      // One caller at a time: the table refuses a `reset()` that overlaps a
      // teardown or comes from inside `run`, and throws it from `send`.
      const done = deferred<void>();
      const chosen = send({ _tag: "reset", done });
      return chosen._tag === "tearingDown" ? done.promise : Promise.resolve();
    },
  };
}
