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
import {
  type BootingRuntime,
  type Cmd,
  type Machine,
  type Runtime,
  run,
  type Store,
  type Sub,
} from "../index";
import { autoBoot } from "./resume";
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
//   - the `autoBoot` re-fire on a rehydrated suspended run,
//   - the SSE hub (so `host.sse.open()` / `host.sse.register(...)` is the route +
//     the test seam), and
//   - the framework test/lifecycle seam ONCE: `status()`, `result()`, `reset()`.
//
// The consumer supplies ONLY its mappings: how to build the machine, the Store,
// the Ctx, the terminal predicate, and the `AgentEvent → SSE frame` projection.
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
 */
export interface AgentHostConfig<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
  Ctx = unknown,
> {
  /**
   * Build the wired agent machine. Called once per host build (per activation),
   * AFTER the previous runtime — if any — was torn down. The consumer wires its
   * per-tool interpret here (`agent.toMachine({ toolInterpret })`).
   */
  readonly buildMachine: () => Machine<
    AgentState<Stage, P, O, R>,
    AgentMachineMsg<P, O, R>,
    C,
    U,
    Ctx
  >;
  /** The durable `Store` for the agent slice (typically `doStore(storage, parse)`). */
  readonly store: Store<AgentState<Stage, P, O, R>>;
  /** The Ctx the machine threads to its interpret cells — checked against `buildMachine`'s. */
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
 * The assembled host: the runtime cell + the SSE hub + the framework test seam,
 * owned ONCE. A DO holds one `AgentHost` and delegates to it; its own surface
 * shrinks to the domain (the gateway, the WS bridge, the command-send mapping).
 *
 * @typeParam Stage Pipeline stage type.
 * @typeParam P     Brain-call purposes.
 * @typeParam O     Per-purpose outputs (bound to {@link AgentTurn}).
 * @typeParam R     Tool result type.
 * @typeParam Frame The consumer's SSE event shape.
 */
export interface AgentHost<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
> {
  /**
   * Get (or build) the booted runtime. Build-once-boot-once: the first call
   * builds the machine, wires SSE off the semantic event stream, awaits the boot
   * gate, runs the `autoBoot` re-fire for a rehydrated suspended run, and caches
   * the booted `Runtime`; subsequent calls return the cached handle. The single
   * assembly every consumer used to hand-roll in `getRuntime()`.
   */
  runtime(): Promise<
    Runtime<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>, AgentEvent<R>>
  >;
  /**
   * The agent's lifecycle status (#49) — the ONE typed channel a consumer reads
   * instead of re-deriving `run.phase` / `awaiting` by hand. Ensures the runtime
   * is built + boot-reconciled first. Replaces the per-consumer `isSuspended` /
   * `runPhase` test methods (read `status().kind`).
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
   * Tear down the cached runtime (drain its tail via `stop()`, drop the handle)
   * so the next `runtime()` rebuilds from storage. The framework `settle` test
   * seam, owned once.
   */
  reset(): Promise<void>;
}

/**
 * Build an {@link AgentHost} from the consumer's domain mappings. Owns the
 * runtime+events+autoBoot assembly and the framework test seam — the wiring
 * issue #53 had every consumer re-write.
 *
 * @example
 *   const host = createAgentHost<Stage, Purpose, Outputs, ClientResult, SseEvent>({
 *     buildMachine: () => agent.toMachine<Ctx>({ toolInterpret }),
 *     store: doStore(storage, parse),
 *     ctx,
 *     toSseFrame: (e) =>
 *       e.type === "ToolSettled" ? { kind: "result", ...} :
 *       e.type === "TurnSettled" && e.turn.toolCalls.length === 0
 *         ? { kind: "verdict", verdict: e.turn.content } :
 *       e.type === "RunDone" ? { kind: "phase", phase: "done" } : null,
 *   });
 *   // route:   return host.sse.open();
 *   // start:   await (await host.runtime()).dispatch({ type: "agent_start", ... });
 *   // test:    (await host.status()).kind === "suspended"
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
>(
  config: AgentHostConfig<Stage, P, O, R, Frame, C, U, Ctx>,
): AgentHost<Stage, P, O, R, Frame> {
  type S = AgentState<Stage, P, O, R>;
  type M = AgentMachineMsg<P, O, R>;
  type E = AgentEvent<R>;

  const sse = sseHub<Frame>();
  const now = config.now ?? Date.now;
  const isTerminal =
    config.terminal ??
    ((s: S) => s.run.phase === "done" || s.run.phase === "failed");

  let cached: Runtime<S, M, E> | null = null;

  async function runtime(): Promise<Runtime<S, M, E>> {
    if (cached !== null) return cached;

    // `run()` hands back a `BootingRuntime` synchronously (#45). Wire the
    // SEMANTIC event projector (#47) so `runtime.on(...)` lights up, then drive
    // the SSE hub off that named stream (never the private-Msg firehose). The
    // `terminal` predicate makes `result()` / `done()` meaningful (#46).
    const booting: BootingRuntime<S, M, E> = run(config.buildMachine(), {
      ctx: config.ctx,
      store: config.store,
      events: agentEvents<Stage, P, O, R>(),
      terminal: isTerminal,
    });

    // SSE off the semantic stream. Subscriptions attach on the booting handle
    // (total before boot), so the hub catches every event from the first
    // transition. The cleanup is implicit: the host tears the whole runtime
    // down in `reset()`, dropping every subscription with it.
    sseFromAgentEvents(booting, sse, config.toSseFrame);

    // Re-fire the one outstanding tool effect IFF this wake rehydrated a
    // suspended run (no-op on a fresh DO). `autoBoot` awaits the same boot gate.
    await autoBoot(booting, now);
    cached = await booting.ready;
    return cached;
  }

  return {
    runtime,
    async status(): Promise<AgentStatus<Stage>> {
      return status((await runtime()).getState());
    },
    async result(): Promise<S | undefined> {
      return (await runtime()).result();
    },
    sse,
    async reset(): Promise<void> {
      if (cached === null) return;
      await cached.stop();
      cached = null;
    },
  };
}
