/**
 * @demlik/tea/agent — `defineAgent`, the lid over `createAgent` (#59).
 *
 * `defineAgent({ model, tools, instructions })` is the three-line door: it
 * defaults the single-stage wiring (`stages`, `turnOf`, `schemas`), derives the
 * tool cells from `toolRouter`, renders the prompt off the Model, and absorbs
 * the drive loop through `driveToDone`. It hides wiring, never state (ADR
 * 0015): the Model it runs is the same `AgentState` a hand-wired `createAgent`
 * produces, under the same keys, and `machine(input)` is the door down to the
 * raw kernel `run`. Each hidden thing is a named helper below.
 */

import { driveToDone, type Machine, run } from "../index";
import type { DeadlineSub } from "../internal/flow/monitored-run";
import type { LlmCall, MessageLoader, PlainModel } from "../llm-call";
import { MsgType } from "../protocol";
import type { RequiredCtx } from "../pure/core";
import type { CtxArg, Store } from "../runtime-types";
import { createAgent } from "./index";
import { type AgentCmd, type AgentMachineMsg, agentBootMsg } from "./machine";
import {
  type AnyToolDef,
  type ToolCmd,
  type ToolResult,
  toolRouter,
  type WiredToolMsg,
} from "./tool";
import {
  type AgentState,
  type AgentTurn,
  agentTurnSchema,
  type Conversation,
  status,
  type ToolCall,
  type ToolOutcome,
} from "./types";

// ===========================================================================
// The lid's vocabulary: the messages a plain model reads, the prompt they are
// rendered from, and the one-purpose agent it fixes.
// ===========================================================================

/**
 * One message the lid's `model` receives. Plain data the adapter renders into
 * its provider's shape: the head is the `instructions` (when set) and the
 * run's `input`; then, per model turn, the `assistant` turn followed by the
 * `tool` outcomes that turn asked for. A tool outcome rides as data — the
 * adapter decides how a failure reads to its model.
 */
export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly outcome: ToolOutcome<unknown>;
    };

/**
 * The brain-call payload the lid builds from the durable state — everything
 * `messagesOf` renders, so the prompt is a pure function of the Model and the
 * resilient slice carries exactly what was sent.
 */
export interface AgentPrompt<R> {
  readonly instructions: string | null;
  readonly input: string | null;
  readonly conversation: Conversation<R>;
}

/** The one purpose the lid's agent runs. */
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

/** The wired machine `defineAgent` builds per `input` — feed it to the raw `run`. */
export type DefinedAgentMachine<T extends AnyToolDef> = Machine<
  DefinedAgentState<T>,
  AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>> | WiredToolMsg<T>,
  AgentCmd<LidPurpose, ToolCmd<T>, false, false>,
  DeadlineSub,
  DefinedAgentCtx<T>
>;

/** What `defineAgent` takes: the three intents, plus the two run guards. */
export interface DefineAgentConfig<T extends AnyToolDef> {
  /** The brain: `async (messages) => turn`, validated through `agentTurnSchema`. */
  readonly model: PlainModel<AgentMessage, AgentTurn>;
  /** The `tool()`s the model may call. */
  readonly tools: readonly T[];
  /** The system prompt — stored on the Model at `init` (ADR 0004). */
  readonly instructions: string;
  /** Livelock guard: bound on model round-trips. Omit → no turn guard. */
  readonly maxTurns?: number;
  /** No-progress watchdog budget, in ms. Omit → no watchdog. */
  readonly deadlineMs?: number;
}

/** Host wiring for one `run`: the store, the ctx the tools need, a runId, a clock. */
export type DefinedAgentRunOptions<T extends AnyToolDef> = CtxArg<
  DefinedAgentCtx<T>
> & {
  readonly store?: Store<DefinedAgentState<T>>;
  /** The run's identity. Omit → a fresh UUID. */
  readonly runId?: string;
  /** The clock that stamps `at`. Omit → `Date.now`. */
  readonly clock?: () => number;
};

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
}

// ===========================================================================
// The lid.
// ===========================================================================

/**
 * Define an agent from its three intents. The run's `input` is its single
 * stage, so it is durable on the Model beside `instructions`; the prompt is
 * rendered from those two and the conversation on every model call.
 */
export function defineAgent<T extends AnyToolDef>(
  config: DefineAgentConfig<T>,
): DefinedAgent<T> {
  const tools = toolRouter(config.tools);
  const machine = (input: string): DefinedAgentMachine<T> =>
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
      model: config.model,
      instructions: config.instructions,
      payloadOf: promptOf,
      loadMessages: messagesOf,
      toolOf: tools.toolOf,
      maxTurns: config.maxTurns,
      deadlineMs: config.deadlineMs,
    }).toMachine<DefinedAgentCtx<T>, T>({ tools });
  const drive: DefinedAgent<T>["run"] = (input, ...[opts = noHost<T>()]) =>
    driveToDone(
      run(machine(input), { ...opts, terminal: isDone }),
      (booted) => {
        const at = (opts.clock ?? Date.now)();
        return isMidRun(booted)
          ? agentBootMsg(at)
          : startMsg(opts.runId ?? crypto.randomUUID(), at);
      },
      isDone,
      { failed: isFailed },
    );
  return { machine, run: drive };
}

// ===========================================================================
// The named parts the lid composes.
// ===========================================================================

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
 * The payload is what `promptOf` built for this same lid, so the narrowing is
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
    { role: "assistant", content: turn.content, toolCalls: turn.toolCalls },
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
 * The options a `run` with no host wiring gets. `opts` may be omitted only when
 * no tool demands ctx — the `run` signature requires it otherwise — so the
 * empty record is a complete options value there, which is what this asserts.
 */
function noHost<T extends AnyToolDef>(): DefinedAgentRunOptions<T> {
  return {} as DefinedAgentRunOptions<T>;
}

/** The Msg that sets a run in motion. */
function startMsg(runId: string, at: number) {
  return { type: MsgType.AgentStart, runId, at } as const;
}

/**
 * Whether the boot State is a run the Store handed back mid-flight — live, or
 * suspended on tools — which `agent_boot` resumes at its one outstanding
 * effect. A `start` here would mint a new `runId` and a fresh conversation
 * over the work already done; that is a restart, and the durable half of the
 * lid is exactly that it never does one. PURE.
 */
function isMidRun(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  // Off `run.phase`, not `status`: `status` reads an `idle` (never started)
  // Model as `running` too, and idle is exactly the State a start belongs to.
  return s.run.phase === "running" && status(s).kind !== "failed";
}

/** The drive's terminal predicate — the pipeline finished. PURE. */
function isDone(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  return s.run.phase === "done";
}

/** The drive's failure predicate — either failure channel, via `status`. PURE. */
function isFailed(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  return status(s).kind === "failed";
}
