/**
 * @demlik/tea/agent — `agentTool()`: a child `defineAgent` as one tool a parent
 * agent calls and awaits.
 *
 * The child is a durable run of its own, never a slice of the parent's Model:
 * its `Store` and `runId` are keyed by the parent call's `callId` under a
 * namespace the consumer reads off the parent's ctx. That key is the whole
 * durability story. A parent resumed after an eviction re-fires the tool Cmd it
 * was waiting on; the re-fired call reaches the same key, so `defineAgent`'s own
 * `run` boots the child where its Store left it, or resolves a child that
 * already ended without calling its model again. This is Temporal's child
 * workflow (a re-issued start with the same id attaches to the same run),
 * LangGraph's namespaced subgraph checkpoint and the OpenAI Agents SDK's
 * `agent.as_tool()` (the parent keeps control and gets a result back).
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Outcome } from "../index";
import type { HandlerCtx } from "../pure/core";
import { DriveFailedError, type Store } from "../runtime-types";
import type {
  DefinedAgent,
  DefinedAgentCtx,
  DefinedAgentResolvedState,
  DefinedAgentRunOptions,
  DefinedAgentState,
} from "./define-agent";
import type { AnyToolDef, ToolDef, ToolThrown } from "./tool";
import { definedTool, type NotReserved } from "./tool-cell";
import { type AgentTerminalFailure, type AgentTurn, status } from "./types";

/** Why a child run ended `failed` — the reason `status()` reports for it. */
export type ChildFailureReason = AgentTerminalFailure<string>["reason"];

/**
 * The failures an agent tool settles with beside `thrown`. Each carries the
 * child's `childRunId`, so the parent model's reason names the run a human can
 * go and read. A child that `failed` also carries why — `turn_limit` when it hit
 * its own `maxTurns`, `elapsed_limit`, `llm`, `deadline` or `stage`. A child that
 * was `cancelled` (its `stopWhen` answered `true`) carries nothing more, because
 * nothing went wrong.
 */
export type AgentToolError =
  | {
      readonly _tag: "child_failed";
      readonly childRunId: string;
      readonly failure: ChildFailureReason;
    }
  | { readonly _tag: "child_cancelled"; readonly childRunId: string };

/** The tags `AgentToolError` declares, in the order `agentTool` registers them. */
const AGENT_TOOL_TAGS = [
  "child_failed",
  "child_cancelled",
] as const satisfies readonly AgentToolError["_tag"][];

/**
 * How the child's ctx is derived from the parent's. Required when the child's
 * tools read a ctx, and optional — defaulting to none — when they read nothing,
 * the same rule `run`'s own `ctx` option follows.
 */
type ChildCtxOption<CT extends AnyToolDef, Ctx> = [
  Record<never, never>,
] extends [DefinedAgentCtx<CT>]
  ? { readonly childCtx?: (ctx: HandlerCtx<Ctx>) => DefinedAgentCtx<CT> }
  : { readonly childCtx: (ctx: HandlerCtx<Ctx>) => DefinedAgentCtx<CT> };

/** What `agentTool` takes. */
export type AgentToolSpec<Args, Ok, CT extends AnyToolDef, Ctx> = {
  /** The model-facing sentence — the same field `tool()` declares. */
  readonly description: string;
  /** Parses the parent model's `args`. */
  readonly input: StandardSchemaV1<unknown, Args>;
  /** Parses what `result` returns, at the edge, like any tool's `ok`. */
  readonly ok: StandardSchemaV1<unknown, Ok>;
  /**
   * The child. Its bounds (`maxTurns`, `maxElapsedMs`, `stopWhen`), its tools
   * and its instructions are all its own definition's; the helper adds none.
   */
  readonly agent: DefinedAgent<CT>;
  /**
   * The child's whole input, derived from the call's args. It is the only thing
   * the child is told: the parent's conversation never reaches it.
   */
  readonly prompt: (args: Args) => string;
  /** The value the parent call settles with, read off the child's final turn. */
  readonly result: (output: AgentTurn) => Ok;
  /**
   * The namespace the child run's key sits under, read off the parent's ctx —
   * the parent run's id, a tenant, whatever keeps two parents' calls apart.
   * The key is `<namespace>/<callId>`.
   */
  readonly namespace: (ctx: HandlerCtx<Ctx>) => string;
  /**
   * The child run's Store at `key`. The same key must reach the same durable
   * cell on every call, in every process — that is what makes a re-fired call
   * resume the child instead of restarting it.
   */
  readonly store: (
    key: string,
    ctx: HandlerCtx<Ctx>,
  ) => Store<DefinedAgentState<CT>>;
} & ChildCtxOption<CT, Ctx>;

/**
 * Wrap a child `defineAgent` as a tool a parent `defineAgent` calls and awaits
 * — pass it the child, how to phrase its input and how to read its answer, and
 * get back a tool definition the parent's `tools` accepts like any `tool()`.
 *
 * A call runs the child to the end of its run and settles the parent's call:
 *
 *   - child `done` → `ok(result(output))`;
 *   - child `failed` → `{ _tag: "child_failed", childRunId, failure }`;
 *   - child `cancelled` → `{ _tag: "child_cancelled", childRunId }`.
 *
 * Both failures are data the parent model reads as the call's reason, so the
 * parent run neither rejects nor throws when its child fails; it takes its next
 * turn.
 *
 * The child's Store and `runId` are both the key `<namespace>/<callId>`. Firing
 * the same call twice reaches the same child run, and a different call reaches
 * a different one. So a parent killed while its child runs resumes the child
 * from its Store when the tool Cmd re-fires: no settled child turn calls the
 * model again, and no settled child tool runs again. A child that had already
 * ended resolves with the outcome it recorded.
 *
 * It declares no `timeoutMs` and no `retry`. A timeout would settle the parent
 * call while the child keeps running under the same key, and a retry of a child
 * that ended `failed` reaches that same ended run and reads the same failure.
 */
export function agentTool<
  const Name extends string,
  Args,
  Ok,
  CT extends AnyToolDef,
  Ctx = unknown,
>(
  name: Name & NotReserved<Name>,
  spec: AgentToolSpec<Args, Ok, CT, Ctx>,
): ToolDef<Name, Args, Ok, AgentToolError | ToolThrown, Ctx> {
  // `run`'s option tuple is conditional on the child's ctx, which TypeScript
  // cannot resolve over a generic `CT`; `ChildCtxOption` states the same rule
  // on the spec, so the call is read at the options' plain shape.
  const runChild = spec.agent.run as (
    input: string,
    opts: DefinedAgentRunOptions<CT>,
  ) => Promise<DefinedAgentResolvedState<CT>>;
  const childCtx = spec.childCtx as
    | ((ctx: HandlerCtx<Ctx>) => unknown)
    | undefined;
  // Only the three fields a tool spec shares are handed on. The child's answer
  // reaches the parent as data, so an agent tool has no `content`, no timeout
  // and no retry — and a spec object carrying any of them at runtime still
  // builds a tool without them.
  return definedTool<Name, Args, Ok, AgentToolError | ToolThrown, Ctx>(
    "agentTool",
    name,
    { description: spec.description, input: spec.input, ok: spec.ok },
    AGENT_TOOL_TAGS,
    async (cmd, ctx) => {
      const childRunId = `${spec.namespace(ctx)}/${cmd.callId}`;
      const opts = {
        store: spec.store(childRunId, ctx),
        runId: childRunId,
        ...(childCtx === undefined ? {} : { ctx: childCtx(ctx) }),
      } as DefinedAgentRunOptions<CT>;
      let final: DefinedAgentResolvedState<CT>;
      try {
        final = await runChild(spec.prompt(cmd.args), opts);
      } catch (error) {
        if (!(error instanceof DriveFailedError)) throw error;
        return Outcome.err(childFailed(childRunId, error.state));
      }
      if (final.run.phase === "cancelled") {
        return Outcome.err({ _tag: "child_cancelled", childRunId });
      }
      if (final.output === null) {
        throw new Error(
          `agentTool: child run "${childRunId}" ended done with no output`,
        );
      }
      return Outcome.ok(spec.result(final.output));
    },
  );
}

/** The failure a child that ended `failed` settles the parent call with. PURE. */
function childFailed(
  childRunId: string,
  state: DefinedAgentState<AnyToolDef>,
): AgentToolError {
  const s = status(state);
  if (s.kind !== "failed") {
    throw new Error(
      `agentTool: child run "${childRunId}" rejected on a ${s.kind} Model`,
    );
  }
  return { _tag: "child_failed", childRunId, failure: s.failure.reason };
}
