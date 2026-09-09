/**
 * @demlik/tea/agent — `defineAgent`, the convenience layer over `createAgent`.
 *
 * `defineAgent({ model, tools, instructions })` is the three-line door: it
 * defaults the single-stage wiring (`stages`, `turnOf`, `schemas`), derives the
 * tool handlers from `toolRouter`, renders the prompt off the Model, and absorbs
 * the drive loop through `driveToDone`. It hides wiring, never state (ADR
 * 0015): the Model it runs is the same `AgentState` a hand-wired `createAgent`
 * produces, under the same keys, and `machine(input)` is the door down to the
 * raw kernel `run`. Each hidden thing is a named helper below.
 */

import { defineMachine, driveToDone, type Machine, run } from "../index";
import type { DeadlineSub } from "../internal/flow/monitored-run";
import type { LlmCall, MessageLoader, PlainModel } from "../internal/llm-call";
import { MsgType } from "../protocol";
import type { Interpret, RequiredCtx } from "../pure/core";
import type { BootingRuntime, CtxArg, Store } from "../runtime-types";
import { createAgent } from "./index";
import {
  type AgentCmd,
  type AgentEvent,
  type AgentMachineMsg,
  agentBootMsg,
  agentEvents,
} from "./machine";
import {
  type AnyToolDef,
  type ToolCmd,
  type ToolFailureOf,
  type ToolResult,
  type ToolRouter,
  toolRouter,
  type WiredToolMsg,
} from "./tool";
import {
  type AgentState,
  type AgentTurn,
  agentTurnSchema,
  type Conversation,
  isStreamingModel,
  type ModelStream,
  type StreamingModel,
  status,
  type ToolCall,
  type ToolOutcome,
  type TurnChunk,
} from "./types";

// ===========================================================================
// The convenience layer's vocabulary: the messages a plain model reads, the
// prompt they are rendered from, and the one-purpose agent it fixes.
// ===========================================================================

/**
 * One message a `defineAgent` `model` receives. Plain data the adapter renders into
 * its provider's shape: the head is the `instructions` (when set) and the
 * run's `input`; then, per model turn, the `assistant` turn followed by the
 * `tool` outcomes that turn asked for. A tool outcome rides as data — the
 * adapter decides how a failure reads to its model. An `assistant` message
 * carries the turn's opaque `provider` slot exactly as the adapter returned it
 * (see `AgentTurn`), present only when the stored turn has one.
 */
export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
      readonly provider?: unknown;
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly outcome: ToolOutcome<unknown>;
    };

/**
 * The brain-call payload `defineAgent` builds from the durable state — everything
 * `messagesOf` renders, so the prompt is a pure function of the Model and the
 * resilient slice carries exactly what was sent.
 */
export interface AgentPrompt<R> {
  readonly instructions: string | null;
  readonly input: string | null;
  readonly conversation: Conversation<R>;
}

/** The one purpose a `defineAgent` agent runs. */
export type LidPurpose = "act";
type LidOutputs = { readonly [K in LidPurpose]: AgentTurn };

/** The Model a defined agent runs — a hand-wired `createAgent`'s, key for key. */
export type DefinedAgentState<T extends AnyToolDef> = AgentState<
  string,
  LidPurpose,
  LidOutputs,
  ToolResult<T>
>;

/** The ctx the tools' `needs` demand, intersected — what `run` asks for. */
export type DefinedAgentCtx<T extends AnyToolDef> = RequiredCtx<ToolCmd<T>>;

/** The Msg union a defined agent's machine folds. */
export type DefinedAgentMsg<T extends AnyToolDef> =
  | AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>>
  | WiredToolMsg<T>;

/** The Cmd union a defined agent's machine emits — one interpret cell per member. */
export type DefinedAgentCmd<T extends AnyToolDef> = AgentCmd<
  LidPurpose,
  ToolCmd<T>,
  false,
  false
>;

/**
 * The interpret table of the machine `defineAgent` wired: one cell per
 * {@link DefinedAgentCmd}, keyed by its `type` — a tool's own Cmd type, the
 * router's `tool_rejected`, and the agent-owned brain call.
 */
export type DefinedAgentInterpret<T extends AnyToolDef> = Interpret<
  DefinedAgentMsg<T>,
  DefinedAgentCmd<T>,
  DefinedAgentCtx<T>
>;

/** The wired machine `defineAgent` builds per `input` — feed it to the raw `run`. */
export type DefinedAgentMachine<T extends AnyToolDef> = Machine<
  DefinedAgentState<T>,
  DefinedAgentMsg<T>,
  DefinedAgentCmd<T>,
  DeadlineSub,
  DefinedAgentCtx<T>
>;

/**
 * The brain a defined agent runs, in either of its two shapes:
 *
 *   - `async (messages) => turn` — the plain port, and the common path.
 *   - `async (messages, { onChunk }) => turn` — the same call, plus a side
 *     channel it may write token deltas to while the turn is in flight.
 *
 * `defineAgent` takes one field for both and tells them apart by arity
 * (`isStreamingModel`), so there is no config flag saying which you passed and
 * no way for that flag to disagree with the function. Whichever shape you
 * write, the run's Model is the same: the turn it RESOLVES is what the reducer
 * folds, and the deltas end at the `onChunk` run option (see
 * {@link DefinedAgentRunOptions}).
 *
 * Both members are unions of one signature so a model written inline still gets
 * its `messages` parameter typed from the config field.
 */
export type DefinedAgentModel =
  | PlainModel<AgentMessage, AgentTurn>
  | StreamingModel<AgentMessage, AgentTurn>;

/**
 * What `defineAgent` takes: the model, the tools and the instructions, plus the
 * two optional guards that stop a run — `maxTurns` and `deadlineMs`. Omit both
 * and the run is unbounded: it ends only when the model stops asking for tools.
 */
export interface DefineAgentConfig<T extends AnyToolDef> {
  /** The brain — either {@link DefinedAgentModel} shape. */
  readonly model: DefinedAgentModel;
  /** The `tool()`s the model may call. */
  readonly tools: readonly T[];
  /** The system prompt — stored on the Model at `init` (ADR 0004). */
  readonly instructions: string;
  /**
   * Stops a run that keeps going: the maximum number of model round-trips it
   * may take. Once the completed-turn count reaches it the run fails rather
   * than calling the model again. Omit → no limit on turns.
   */
  readonly maxTurns?: number;
  /**
   * Stops a run that stops progressing: milliseconds the run may sit without
   * advancing before it fails. The budget is a no-progress watchdog, not a
   * total wall-clock cap — it restarts each time the run moves. Omit → no
   * watchdog.
   */
  readonly deadlineMs?: number;
  /**
   * Observe a tool call that failed, typed against THIS agent's tools: the
   * outcome is `{ kind: "error", _tag, …payload, reason }` over
   * `ToolError`'s union — declared tags, `thrown`, `malformed_result`,
   * `unknown_tool`, `malformed_args` — so a `switch` on `_tag` is exhaustive and an
   * unhandled failure mode is a compile error rather than a silent turn (#115).
   * The model still reads `reason` next turn either way — this is the host's
   * channel beside it, never instead of it.
   *
   * Called ONCE per failed call, at the interpret boundary: after the handler
   * settled, before the failure is folded into the conversation. It is awaited,
   * so an async hook holds the settle until it resolves — keep it short, and put
   * anything slow on your own queue.
   *
   * A resume calls it for the calls THIS process runs and no others: an outcome
   * a previous process already folded is in the Model the Store handed back and
   * is never re-interpreted, so a durable run does not re-fire the hook over its
   * history.
   *
   * The hook is CONTAINED, exactly as `onEvent` is: a throw (or a rejected
   * promise) is warned about and the run goes on, so `run`'s contract does not
   * depend on the hook's.
   *
   * Omit → the router is wired unwrapped and nothing observes failures.
   */
  readonly onToolError?: (
    outcome: ToolFailureOf<T>,
    ctx: ToolErrorContext,
  ) => void | Promise<void>;
}

/**
 * Which call an `onToolError` failure belongs to: the model's `callId` — the
 * fan-out identity the outcome folds back on — and the tool `name` the model
 * asked for, which for an `unknown_tool` is the name it invented rather than
 * any declared tool.
 */
export interface ToolErrorContext {
  readonly callId: string;
  readonly name: string;
}

/**
 * One lifecycle event a defined agent's run emits — {@link AgentEvent} with the
 * tool results typed against this agent's own tool set.
 */
export type DefinedAgentEvent<T extends AnyToolDef> = AgentEvent<ToolResult<T>>;

/** Host wiring for one `run`: the store, the ctx the tools need, a runId, a clock. */
export type DefinedAgentRunOptions<T extends AnyToolDef> = CtxArg<
  DefinedAgentCtx<T>
> & {
  readonly store?: Store<DefinedAgentState<T>>;
  /** The run's identity. Omit → a fresh UUID. */
  readonly runId?: string;
  /** The clock that stamps `at`. Omit → `Date.now`. */
  readonly clock?: () => number;
  /**
   * Observe the run's turn-level lifecycle events — `TurnSettled`,
   * `ToolSettled`, `RunDone` — in the order the kernel settles them. This is
   * the progress seam: without it the only way to see anything mid-run is
   * `machine(input)` plus the raw kernel loop.
   *
   * It forwards the runtime's existing semantic stream (`agentEvents()` /
   * `runtime.on`); it mints no vocabulary of its own, so a consumer folds the
   * same {@link AgentEvent}s a hand-wired `run` would.
   *
   * The listener is CONTAINED: a throw is caught and warned, never allowed to
   * take the run down, and never observable in `run`'s resolution. Only
   * transitions applied by THIS process project events, so a store-backed
   * resume replays nothing that settled before the boot.
   *
   * Omit → no projector is wired and the run behaves exactly as before.
   */
  readonly onEvent?: (event: DefinedAgentEvent<T>) => void;
  /**
   * Observe the token deltas of the turn being produced right now — the
   * granularity below `onEvent`'s. Wired only when the configured `model` is
   * the streaming shape (`async (messages, { onChunk }) => turn`); a plain
   * model has no deltas to give, so passing this beside one is silent.
   *
   * Chunks ride a SIDE CHANNEL, never state. They are not projected off
   * transitions like an {@link AgentEvent} is, because nothing about a chunk is
   * a transition: it is never journaled, never written to the `Store`, and
   * never folded into the Model. That is the whole rule this option obeys — a
   * delta that has not settled is not an outcome, so a run that dies mid-turn
   * loses its chunks and resumes from the last SETTLED turn, and a resumed run
   * re-emits nothing it did not itself re-produce.
   *
   * The listener is CONTAINED exactly as `onEvent`'s is: a throw is caught and
   * warned, never allowed to fail the model call it fired from.
   *
   * Omit → the streaming model is still invoked in its streaming shape, with a
   * sink that drops every chunk.
   */
  readonly onChunk?: (chunk: TurnChunk) => void;
};

/**
 * One decorator per interpret cell you name: it receives the cell the agent
 * wired (`next`) and returns the cell that runs in its place. Every key is
 * optional and a cell nobody names is passed through by REFERENCE, so an
 * overlay that wraps one tool leaves the others the exact functions
 * `defineAgent` built.
 *
 * The wrapper's signature is the cell's, so calling `next(cmd, ctx, dispatch)`
 * is how the wrapped work happens — that is the typed Cmd→Msg edge
 * (`Cmd.define`'s `_ok` / `_err` Msgs), and returning its Msg is what keeps the
 * fold, and therefore a replay, identical to the unwrapped run's.
 */
export type InterpretOverlay<T extends AnyToolDef> = CellWrappers<
  DefinedAgentInterpret<T>
>;

/**
 * The decorator table over an interpret table `I`. Written over a bare type
 * parameter because `I[K]` is only indexable when `I` is one: applying the
 * mapped type to `DefinedAgentInterpret<T>` inline leaves TypeScript indexing
 * an unreduced generic mapped type, which it refuses.
 */
type CellWrappers<I> = {
  readonly [K in keyof I]?: (next: I[K]) => I[K];
};

/**
 * What `defineAgent(cfg).with(...)` takes — the one documented wrap point over
 * the machine the lid built.
 */
export interface DefinedAgentOverlay<T extends AnyToolDef> {
  readonly interpret: InterpretOverlay<T>;
}

/** What `defineAgent` returns. */
export interface DefinedAgent<T extends AnyToolDef> {
  /**
   * Run `input` to its terminal Model. Resolves on `run.phase: "done"`; a
   * failed run rejects with `DriveFailedError` carrying the failed Model.
   *
   * With a `store`, the same call is also the resume: a Model the Store hands
   * back mid-run is booted (`agent_boot`) at its one outstanding effect —
   * same `runId`, no tool re-run — and one already `done` resolves as it is.
   * A fresh start needs an empty Store.
   */
  readonly run: (
    input: string,
    ...opts: [Record<never, never>] extends [DefinedAgentCtx<T>]
      ? [opts?: DefinedAgentRunOptions<T>]
      : [opts: DefinedAgentRunOptions<T>]
  ) => Promise<DefinedAgentState<T>>;
  /** The machine `run` drives for `input` — the door down to the raw kernel. */
  readonly machine: (input: string) => DefinedAgentMachine<T>;
  /**
   * The ramp between the lid and `createAgent`: wrap ONE interpret cell of the
   * machine this agent builds and get back a NEW defined agent that runs the
   * wrapped table. The agent it is called on is untouched, and so is every cell
   * the overlay does not name.
   *
   *     const traced = agent.with({
   *       interpret: {
   *         fetch_rate: (next) => async (cmd, ctx, dispatch) => {
   *           console.time(cmd.callId);
   *           try { return await next(cmd, ctx, dispatch); }
   *           finally { console.timeEnd(cmd.callId); }
   *         },
   *       },
   *     });
   *
   * The wrapped cell settles through the SAME typed Cmd→Msg edge as the cell it
   * wraps — it returns whatever `next` returned — so the reducer folds the same
   * Msgs and a replay of a wrapped run is the unwrapped run's replay. That is
   * the whole contract: the door is one over the effect boundary, never over
   * the fold. A cell that must settle DIFFERENTLY is a different machine, and
   * `createAgent` is still where you build one.
   *
   * `with` composes — `agent.with(a).with(b)` puts `b`'s wrapper OUTSIDE `a`'s,
   * so `b` is entered first and `a`'s cell is what its `next` calls. Naming a
   * cell the machine has none of throws at `machine(input)`, where the table it
   * is checked against exists.
   */
  readonly with: (overlay: DefinedAgentOverlay<T>) => DefinedAgent<T>;
}

// ===========================================================================
// The defined agent.
// ===========================================================================

/**
 * Define an agent from a model, the tools it may call and its instructions, and
 * get back `run(input)` — a promise of the finished state — plus `machine(input)`
 * for driving the same run yourself.
 *
 * Add `maxTurns` and `deadlineMs` to bound the run; both are described on
 * `DefineAgentConfig`. The run's `input` is its single stage, so it is durable
 * beside `instructions`, and the prompt is rendered from those two and the
 * conversation on every model call.
 *
 * One unusual requirement does not cost you the lid: `.with({ interpret })`
 * wraps one interpret cell of the machine this built and hands back another
 * defined agent, so `createAgent` is for a rebuild rather than for a detour.
 */
export function defineAgent<T extends AnyToolDef>(
  config: DefineAgentConfig<T>,
): DefinedAgent<T> {
  const router = toolRouter(config.tools);
  const { onToolError } = config;
  // No hook → the router is the plain one, so an omitted `onToolError` leaves
  // the interpret table the router always built.
  const tools =
    onToolError === undefined ? router : withToolErrorHook(router, onToolError);
  return definedAgent(config, { router, tools }, []);
}

/** The wiring every agent in one `defineAgent`'s lineage shares. */
interface LidWiring<T extends AnyToolDef> {
  readonly router: ToolRouter<T>;
  readonly tools: ToolRouter<T>;
}

/**
 * The defined agent for one config's wiring and the overlays stacked on it so
 * far. `defineAgent` is this with none; `with` is this with one more, which is
 * why a wrapped agent is a whole agent (`run`, `machine`, `with` again) rather
 * than a second kind of thing, and why the agent it was called on never
 * changes.
 *
 * The wiring is passed IN rather than rebuilt, so a `with` derives an agent that
 * shares the router — and therefore the very interpret cells the overlay does
 * not name.
 */
function definedAgent<T extends AnyToolDef>(
  config: DefineAgentConfig<T>,
  wiring: LidWiring<T>,
  overlays: readonly InterpretOverlay<T>[],
): DefinedAgent<T> {
  const { router, tools } = wiring;
  const { onToolError } = config;
  const machineWith = (
    input: string,
    onChunk: ((chunk: TurnChunk) => void) | undefined,
  ): DefinedAgentMachine<T> =>
    overlaid(
      createAgent<
        string,
        LidPurpose,
        LidOutputs,
        ToolResult<T>,
        ToolCmd<T>,
        AgentMessage
      >({
        stages: [input],
        turnOf: () => "act",
        schemas: { act: agentTurnSchema },
        model: brainOf(config.model, onChunk),
        instructions: config.instructions,
        payloadOf: promptOf,
        loadMessages: messagesOf,
        toolOf: tools.toolOf,
        // The per-tool timeout / retry knob (#117). The lid grows no option for
        // it: the policy is declared on the `tool()` that needs it, and the
        // router is what carries it down to the reducer that runs it.
        toolResilienceOf: tools.resilienceOf,
        maxTurns: config.maxTurns,
        deadlineMs: config.deadlineMs,
      }).toMachine<DefinedAgentCtx<T>, T>({ tools }),
      overlays,
    );
  // The public door down carries no chunk sink: `machine(input)` is handed to
  // the raw kernel by a caller who has no run options to read one from.
  const machine = (input: string): DefinedAgentMachine<T> =>
    machineWith(input, undefined);
  const drive: DefinedAgent<T>["run"] = (input, ...[opts = noHost<T>()]) => {
    const { onEvent, onChunk } = opts;
    // No listener → no projector, so an omitted `onEvent` leaves the run the
    // kernel wiring it always had.
    const handle = run(machineWith(input, onChunk), {
      ...opts,
      terminal: isDone,
      events:
        onEvent === undefined
          ? undefined
          : agentEvents<string, LidPurpose, LidOutputs, ToolResult<T>, T>({
              tools,
            }),
    });
    if (onEvent !== undefined) forwardEvents(handle, onEvent);
    if (onToolError !== undefined) {
      forwardLadderErrors(handle, router, onToolError);
    }
    return driveToDone(
      handle,
      (booted) => {
        const at = (opts.clock ?? Date.now)();
        return isMidRun(booted)
          ? agentBootMsg(at)
          : startMsg(opts.runId ?? crypto.randomUUID(), at);
      },
      isDone,
      { failed: isFailed },
    );
  };
  return {
    machine,
    run: drive,
    with: (overlay) =>
      definedAgent(config, wiring, [...overlays, overlay.interpret]),
  };
}

/**
 * The machine with each overlay's named cells wrapped, in the order they were
 * stacked — so the LAST `with` is the outermost wrapper and the innermost
 * `next` is always the cell the lid itself wired.
 *
 * A cell nobody names is carried over by REFERENCE, which is what "unnamed
 * cells untouched" means literally: the wrapped table holds the same functions
 * for every other key. The machine is rebuilt as a new object rather than
 * mutated, because the same `defineAgent` config builds a fresh machine per
 * `input` and per overlay stack, and it goes back through `defineMachine` so
 * the `__form` tag a spread drops is stamped again.
 *
 * An unknown key throws HERE rather than at `with`: the table to check a name
 * against is the machine's, and the machine exists only per `input`.
 */
function overlaid<T extends AnyToolDef>(
  machine: DefinedAgentMachine<T>,
  overlays: readonly InterpretOverlay<T>[],
): DefinedAgentMachine<T> {
  if (overlays.length === 0) return machine;
  type Cell = (...args: never[]) => Promise<unknown>;
  const cells = { ...(machine.interpret as Record<string, Cell>) };
  for (const overlay of overlays) {
    const wrappers = overlay as unknown as Record<string, (next: Cell) => Cell>;
    for (const [type, wrap] of Object.entries(wrappers)) {
      const cell = cells[type];
      if (cell === undefined) {
        throw new Error(
          `@demlik/tea: defineAgent(...).with named the interpret cell ` +
            `"${type}", which this agent's machine has none of. Its cells are: ` +
            `${Object.keys(cells).sort().join(", ")}.`,
        );
      }
      cells[type] = wrap(cell);
    }
  }
  return defineMachine({
    ...machine,
    interpret: cells as DefinedAgentInterpret<T>,
  } as DefinedAgentMachine<T>);
}

// ===========================================================================
// The named parts `defineAgent` composes.
// ===========================================================================

/**
 * The `ModelPort` `createAgent` is configured with, for either model shape.
 *
 * A plain model is passed through UNTOUCHED — same reference, same one-argument
 * call, so the arity that `isPlainModel` reads (and the misroute error a
 * non-`async` model earns) is exactly what it was before streaming existed. A
 * streaming model is wrapped in an `async` one-argument function that binds this
 * run's sink, which is what makes the sink per-run while `model` stays per-agent.
 *
 * The wrapper resolves whatever the streaming model resolves and adds nothing:
 * the turn still meets `agentTurnSchema` at the same seam, so the settled turn
 * — and therefore the Model — cannot depend on whether anyone watched.
 */
function brainOf(
  model: DefinedAgentModel,
  onChunk: ((chunk: TurnChunk) => void) | undefined,
): PlainModel<AgentMessage, AgentTurn> {
  if (!isStreamingModel(model)) {
    return model as PlainModel<AgentMessage, AgentTurn>;
  }
  const streaming = model as StreamingModel<AgentMessage, AgentTurn>;
  const stream: ModelStream = {
    onChunk: onChunk === undefined ? dropChunk : contained("onChunk", onChunk),
  };
  return async (messages) => streaming(messages, stream);
}

/** The sink a streaming model gets when nobody is watching. PURE. */
function dropChunk(): void {}

/**
 * A caller's listener, wrapped so its defects stay its own: a throw is warned
 * about and swallowed rather than propagated into the run that fired it.
 *
 * The run's contract must not depend on the listener's. For `onEvent` the
 * runtime's own fanout is throw-isolated but routes to `OnError`, whose default
 * re-throws on a fresh macrotask; for `onChunk` there is no fanout at all — the
 * sink is called straight from the adapter, so an escaping throw would reject
 * the model call and settle a `resilient_err` for a defect in a progress bar.
 */
function contained<E>(what: string, listener: (event: E) => void) {
  return (event: E): void => {
    try {
      listener(event);
    } catch (err) {
      console.warn(`@demlik/tea: a run's ${what} listener threw`, err);
    }
  };
}

/** `payloadOf`: the prompt is the durable state, nothing else. PURE. */
function promptOf<R>(
  stage: string | undefined,
  conversation: Conversation<R>,
  instructions: string | null,
): AgentPrompt<R> {
  return { instructions, input: stage ?? null, conversation };
}

/**
 * `loadMessages`: render the call's prompt to the messages the model reads.
 * The payload is what `promptOf` built for this same agent, so the narrowing is
 * an identity — the one place the `unknown` payload is read back typed.
 */
const messagesOf: MessageLoader<LidPurpose, AgentMessage> = async (
  call: LlmCall<LidPurpose>,
) => renderPrompt(call.payload as AgentPrompt<unknown>);

/** The prompt as messages: the head, then each turn with its tool outcomes. PURE. */
export function renderPrompt(prompt: AgentPrompt<unknown>): AgentMessage[] {
  const head: AgentMessage[] = [];
  if (prompt.instructions !== null) {
    head.push({ role: "system", content: prompt.instructions });
  }
  if (prompt.input !== null) {
    head.push({ role: "user", content: prompt.input });
  }
  const { turns, toolRecords } = prompt.conversation;
  const transcript = turns.flatMap<AgentMessage>((turn, i) => [
    assistantOf(turn),
    ...toolRecords
      .filter((r) => r.turn === i)
      .map<AgentMessage>((r) => ({
        role: "tool",
        callId: r.call.callId,
        name: r.call.name,
        outcome: r.outcome,
      })),
  ]);
  return [...head, ...transcript];
}

/**
 * The stored turn as the `assistant` message the model reads back. `provider`
 * rides only when the turn carries one, so a turn persisted before the slot
 * existed renders exactly as it did then. PURE.
 */
function assistantOf(turn: AgentTurn): AgentMessage {
  const { content, toolCalls } = turn;
  return "provider" in turn
    ? { role: "assistant", content, toolCalls, provider: turn.provider }
    : { role: "assistant", content, toolCalls };
}

/**
 * The options a `run` with no host wiring gets. `opts` may be omitted only when
 * no tool demands ctx — the `run` signature requires it otherwise — so the
 * empty record is a complete options value there, which is what this asserts.
 */
function noHost<T extends AnyToolDef>(): DefinedAgentRunOptions<T> {
  return {} as DefinedAgentRunOptions<T>;
}

/**
 * Every `AgentEvent` discriminant, so one `on(...)` subscription per type
 * covers the whole union. Subscribing before the drive dispatches is what makes
 * the delivery total: an event of a type nobody is listening for is dropped by
 * the runtime's fanout, not queued.
 */
const AGENT_EVENT_TYPES = ["TurnSettled", "ToolSettled", "RunDone"] as const;

/**
 * Forward the runtime's semantic events to the caller's `onEvent`, CONTAINED.
 *
 * `defineAgent` owns the containment (see {@link contained}): a throwing
 * listener is warned about and the run goes on to its terminal Model, so
 * `run`'s contract does not depend on the listener's.
 *
 * Ordering is the kernel's: one handler per type, all attached before the
 * drive's first dispatch, so events arrive in the order the projector emits
 * them.
 */
function forwardEvents<T extends AnyToolDef>(
  handle: BootingRuntime<
    DefinedAgentState<T>,
    AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>> | WiredToolMsg<T>,
    DefinedAgentEvent<T>
  >,
  onEvent: (event: DefinedAgentEvent<T>) => void,
): void {
  const deliver = contained("onEvent", onEvent);
  for (const type of AGENT_EVENT_TYPES) {
    handle.on(type, deliver);
  }
}

/**
 * Deliver a LADDERED call's one failure to `onToolError` (#117 meeting #115).
 *
 * `withToolErrorHook` below wraps interpret, and that is the right seam for a
 * call nothing else owns — but a tool declaring `timeoutMs` or `retry` settles
 * once per ATTEMPT there, and the attempts a ladder absorbs are not failures the
 * run produced: the model is shown none of them, and neither is the host. The
 * call's real ending is minted by the reducer (a timeout has no handler settle
 * at all — the call is over while its attempt is still running), so it is
 * readable only off the fold.
 *
 * So the two seams SPLIT on one question, `resilienceOf(call) !== null`, and
 * every call is announced by exactly one of them. That is what makes
 * once-per-call structural rather than a filter the caller writes: a laddered
 * call is silent at interpret and announced here, a bare call the other way
 * round, and neither can announce the other's.
 *
 * The cost is that a laddered call's failure is read AFTER its fold rather than
 * before it — there is nothing earlier to read. The two other clauses hold
 * unchanged: once per settled call (`fired`), and never re-announced on resume,
 * because the boot/start transition seeds `fired` with every record the `Store`
 * handed back and folds none of its own.
 */
function forwardLadderErrors<T extends AnyToolDef>(
  handle: BootingRuntime<
    DefinedAgentState<T>,
    AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>> | WiredToolMsg<T>,
    DefinedAgentEvent<T>
  >,
  router: ToolRouter<T>,
  onToolError: NonNullable<DefineAgentConfig<T>["onToolError"]>,
): void {
  const fired = new Set<string>();
  handle.observe((msg, state) => {
    // `agent_start` and `agent_boot` are the run's first transition and fold no
    // tool record of their own, so every record visible under one is history a
    // `Store` handed back. Reading the Msg rather than "is this the first call"
    // is what makes that a stated invariant instead of an assumed one.
    const seeding =
      msg.type === MsgType.AgentStart || msg.type === MsgType.AgentBoot;
    for (const record of state.conversation?.toolRecords ?? []) {
      const { outcome, call } = record;
      if (outcome.kind !== "error") continue;
      if (fired.has(call.callId)) continue;
      fired.add(call.callId);
      if (seeding) continue;
      // A call no ladder owns was announced at the interpret boundary already.
      if (router.resilienceOf(call) === null) continue;
      void Promise.resolve(
        onToolError(outcome as ToolFailureOf<T>, {
          callId: call.callId,
          name: call.name,
        }),
      ).catch((err: unknown) => {
        console.warn("@demlik/tea: a run's onToolError hook threw", err);
      });
    }
  });
}

/**
 * The router with the consumer's `onToolError` spliced into every interpret
 * handler — the same router, one seam wider.
 *
 * The interpret boundary is where the hook belongs, and the two timing clauses
 * on `onToolError` are properties of that seam rather than bookkeeping this
 * function does: a handler's settled Msg is read back through the router's own
 * `outcomeOf` (so the hook and the conversation see ONE rendering of the
 * failure) and the Msg is returned only after the hook resolves, which is
 * "before the fold"; and interpret runs only for the effects THIS process
 * launches, which is "not again on resume". Nothing is folded, counted or
 * remembered here.
 *
 * `tool_rejected` is wrapped like any other handler, so `unknown_tool` and
 * `malformed_args` reach the hook exactly as a tool's own failure does.
 *
 * A LADDERED call is the one thing this seam stays silent about, because here it
 * is one settle per ATTEMPT and the absorbed ones are not failures the run
 * produced. `forwardLadderErrors` above announces those calls off the fold
 * instead; the two seams split on `resilienceOf` and every call belongs to
 * exactly one.
 */
function withToolErrorHook<T extends AnyToolDef>(
  router: ToolRouter<T>,
  onToolError: NonNullable<DefineAgentConfig<T>["onToolError"]>,
): ToolRouter<T> {
  type Handler = (
    cmd: { readonly type: string },
    ctx: unknown,
  ) => Promise<{ readonly type: string } | void>;
  const handlers = router.interpret as unknown as Record<string, Handler>;
  const wrapped: Record<string, Handler> = {};
  for (const [type, handler] of Object.entries(handlers)) {
    wrapped[type] = async (cmd, ctx) => {
      const msg = await handler(cmd, ctx);
      if (msg === undefined) return msg;
      const settled = router.outcomeOf(msg);
      if (settled === null || settled.outcome.kind === "ok") return msg;
      // A laddered call is announced off its fold, once, by
      // `forwardLadderErrors` — never per attempt from here.
      if (ownedByLadder(router, cmd, settled.callId)) return msg;
      try {
        await onToolError(settled.outcome as ToolFailureOf<T>, {
          callId: settled.callId,
          name: calledName(cmd),
        });
      } catch (err) {
        console.warn("@demlik/tea: a run's onToolError hook threw", err);
      }
      return msg;
    };
  }
  return {
    ...router,
    interpret: wrapped as unknown as ToolRouter<T>["interpret"],
  };
}

/**
 * Whether a ladder owns the call this Cmd is an attempt of — the one question
 * the two `onToolError` seams split on. Read off the same `resilienceOf` the
 * reducer runs the ladder from, so the two can never disagree about who
 * announces a call. A `tool_rejected` names no declared tool, so it is never
 * laddered and always announced at the interpret boundary. PURE.
 */
function ownedByLadder<T extends AnyToolDef>(
  router: ToolRouter<T>,
  cmd: { readonly type: string },
  callId: string,
): boolean {
  return router.resilienceOf({ name: cmd.type, callId, args: {} }) !== null;
}

/**
 * The tool name a Cmd was built for: its own `type`, except for the router's
 * `tool_rejected`, whose type is the router's and whose rejection carries the
 * name the MODEL asked for — the name a consumer needs to see for an
 * `unknown_tool`. PURE.
 */
function calledName(cmd: { readonly type: string }): string {
  const rejection = (cmd as { readonly error?: { readonly name?: unknown } })
    .error;
  return typeof rejection?.name === "string" ? rejection.name : cmd.type;
}

/** The Msg that sets a run in motion. */
function startMsg(runId: string, at: number) {
  return { type: MsgType.AgentStart, runId, at } as const;
}

/**
 * Whether the boot State is a run the Store handed back mid-flight — live, or
 * suspended on tools — which `agent_boot` resumes at its one outstanding
 * effect. A `start` here would mint a new `runId` and a fresh conversation
 * over the work already done; that is a restart, and the durable half of
 * `defineAgent` is exactly that it never does one. PURE.
 */
function isMidRun(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  const { kind } = status(s);
  return kind === "running" || kind === "suspended";
}

/** The drive's terminal predicate — the pipeline finished. PURE. */
function isDone(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  return s.run.phase === "done";
}

/** The drive's failure predicate — either failure channel, via `status`. PURE. */
function isFailed(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  return status(s).kind === "failed";
}
