/**
 * @demlik/tea/agent — `tool()` + `toolRouter()`: declare a tool once and derive
 * what a consumer used to hand-write twice — the `toolOf` mapping from a
 * model's `ToolCall` to an effect Cmd, and the interpret handler that runs it
 * and settles it.
 *
 * A tool is a `Cmd.define`d effect whose input is the model's call —
 * `{ callId, args }` — with the handler colocated on the constructor. The
 * router folds a set of them into one `toolOf` and one interpret table; the
 * handlers settle through the minted `<name>_ok` / `<name>_err` Msgs, errors as
 * `{ _tag }` data (ADR 0011). `createAgent(...).toMachine({ tools })` folds
 * those settles into the conversation, so a consumer names nothing twice.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type AnyCmdDef,
  Cmd,
  type CmdDef,
  type CmdOf,
  type CmdValue,
  type ErrOf,
  type Interpret,
  type MalformedResult,
  type OkOf,
  Outcome,
  type Settled,
  type Tagged,
  type TaggedError,
} from "../index";
import { rejectAll, unchecked } from "../internal/schema";
import {
  cmdEdgeOf,
  detachWorkOf,
  type HandlerCtx,
  malformedResult,
  validateSync,
} from "../pure/core";
import type { ContentPart } from "./content";
import { definedTool, type NotReserved, REJECTED_TYPE } from "./tool-cell";
import type {
  TaggedFailure,
  ToolCall,
  ToolOutcome,
  ToolResilience,
  ToolResilienceError,
} from "./types";

export { isReservedToolName, type ReservedToolName } from "./tool-cell";

// ===========================================================================
// tool() — one declaration: the Cmd, its channels, and the handler.
// ===========================================================================

/**
 * The input a tool Cmd carries: the model's `callId` (the fan-out identity the
 * settle folds back on) and the `args` already parsed against the tool's
 * `input` schema — the boundary parses, the handler trusts.
 */
export type ToolInput<Args> = {
  readonly callId: string;
  readonly args: Args;
};

/**
 * The router-minted failure beside a tool's declared tags: the handler threw
 * (or rejected) with something that is not a declared `{ _tag }`. Plain data
 * the model sees as a reason, never a rejection out of the interpret handler.
 */
export type ToolThrown = { readonly _tag: "thrown"; readonly message: string };

/**
 * The typed success constructor a handler receives: `ok(value)` with `Ok`
 * fixed to what the `ok` schema parses, so a value of the wrong shape is
 * refused where it is written.
 */
export type ToolOk<Ok, E extends Tagged> = (value: Ok) => Outcome<Ok, E>;

/**
 * The typed failure constructor a handler receives: `fail({ _tag })` with `E`
 * fixed to the declared tags, so the literal is checked against them where it
 * is written. (A bare `{ _tag: "x" }` built elsewhere infers `_tag: string`
 * and cannot be — the parameter type is what keeps it literal.)
 */
export type ToolFail<Ok, E extends Tagged> = (error: E) => Outcome<Ok, E>;

/**
 * The two constructors a handler is handed, one per channel — `ok` for the
 * value the `ok` schema parses, `fail` for a declared `{ _tag }`. Both build
 * the core's `Outcome` record (ADR 0021).
 */
export type ToolConstructors<Ok, E extends Tagged> = {
  readonly ok: ToolOk<Ok, E>;
  readonly fail: ToolFail<Ok, E>;
};

/**
 * A tool's handler: the parsed `args`, the plain `ctx` the host handed `run`,
 * and the typed `{ ok, fail }`, to an outcome over the declared channels — `Ok`
 * is what the `ok` schema parses, `E` the declared `_tag` union. An undeclared
 * tag does not compile. `Ctx` is whatever the handler annotates its `ctx`
 * parameter with; tea does no dependency injection (ADR 0020).
 */
export type ToolHandler<Args, Ok, E extends Tagged, Ctx> = (
  args: Args,
  ctx: HandlerCtx<Ctx>,
  settle: ToolConstructors<Ok, E>,
) => Promise<Outcome<Ok, E>>;

/**
 * What `tool()` returns: the `Cmd.define`d constructor (so `Settled<typeof t>`
 * / `CmdOf<typeof t>` read it like any def) plus the colocated `interpret` handler,
 * the bare `args` schema the router parses a call against, and the
 * `description` a provider adapter declares to the model beside that schema.
 * `E` is the full failure union the Cmd settles with — the declared tags plus
 * `thrown`. `Ctx` is the ctx the colocated handler reads — a fact about the
 * handler, never about the Cmd it builds (ADR 0020).
 */
export type ToolDef<
  Name extends string,
  Args,
  Ok,
  E extends Tagged,
  Ctx,
> = CmdDef<Name, ToolInput<Args>, Ok, E> & {
  readonly description: string;
  readonly args: StandardSchemaV1<unknown, Args>;
  /**
   * The timeout / retry knob this tool declared, or `null` when it declared
   * neither. `toolRouter` serves it to the agent as `resilienceOf`.
   */
  readonly resilience: ToolResilience | null;
  /**
   * The parts the model reads for an `ok` result, or `null` when the tool
   * declared no `content` and the model reads the result as data.
   */
  readonly content: ((result: Ok) => readonly ContentPart[]) | null;
  /**
   * The colocated handler, as an interpret cell: it returns the tool's
   * outcome, and the engine mints `<name>_ok` / `<name>_err` from it.
   */
  readonly interpret: (
    cmd: CmdValue<Name, ToolInput<Args>, Ok, E>,
    ctx: HandlerCtx<Ctx>,
  ) => Promise<Outcome<Ok, E>>;
  /** Phantom — the ctx the handler reads. Never assigned. */
  readonly __ctx?: Ctx;
};

/** The declaration-erased view the router reads. */
export type AnyToolDef = AnyCmdDef & {
  readonly description: string;
  readonly args: StandardSchemaV1;
  readonly resilience: ToolResilience | null;
  readonly content: ((result: never) => readonly ContentPart[]) | null;
  readonly interpret: (cmd: never, ctx: never) => Promise<unknown>;
};

/**
 * Declare one tool the model may call — its name, the schemas for its arguments
 * and result, the failures it may return and the handler that runs it — and get
 * back a `Cmd<T, Ok, E>` definition, whose `Ok` is what `ok` parses and whose `E`
 * is the `err` tag union, that you pass to `toolRouter` or `defineAgent`.
 *
 * So a tool's two declared channels ARE the kernel's two typed effect channels
 * (ADR 0014), spelled in schemas rather than in type parameters: a settled
 * failure keeps its `_tag` into the conversation, so a reducer switching over
 * `err`'s tags is exhaustive and an unhandled one is a compile error.
 *
 * `name` is the name the model calls it
 * by; `description` is the model-facing sentence — the one place it lives — a
 * provider adapter declares to the model beside the schema (Anthropic
 * `description`, OpenAI `function.description`) so the model can tell when to
 * call the tool, read off `def.description`, never off the `input` schema;
 * `input` parses the model's `args`; `ok` parses the handler's value at the
 * edge; `err` is the `_tag` list the handler may fail with. The handler reads
 * its services off the plain `ctx` `run` was handed — annotate its `ctx`
 * parameter and `defineAgent` asks for that ctx at `run`. The handler returns
 * one of the two constructors it is handed — `ok(value)` or the typed `fail({ _tag })`; a
 * throw settles `<name>_err` — with the thrown `_tag` when it is a declared
 * one, else as `{ _tag: "thrown", message }`.
 *
 * A `ReservedToolName` does not compile as `name`, and one that reaches here
 * as a widened `string` throws — the same declaration-bug refusal
 * `toolRouter` gives a name declared twice.
 */
export function tool<
  const Name extends string,
  Args,
  Ok,
  const Tags extends readonly string[],
  Ctx = unknown,
>(
  name: Name & NotReserved<Name>,
  spec: {
    readonly description: string;
    readonly input: StandardSchemaV1<unknown, Args>;
    readonly ok: StandardSchemaV1<unknown, Ok>;
    readonly err: Tags;
    /**
     * The budget one call of this tool gets, in ms — the overall cap, measured
     * from the first attempt and not restarted by a retry. When it elapses the
     * call settles as a `ToolOutcome` error carrying `_tag: "timeout"` beside
     * its `reason`, and the loop moves on; the attempt is NOT cancelled (a promise cannot be), so it runs to its
     * own end and its late settle folds nothing. Omit → no cap.
     */
    readonly timeoutMs?: number;
    /**
     * The backoff ladder a failed attempt of this tool climbs — the same
     * `{ baseMs, factor, capMs, jitter, maxAttempts }` shape the brain call's
     * `retry` takes. The ladder is folded into the Model and its wait is a timer
     * Sub, so a process killed between two attempts resumes at the attempt it
     * was on. A spent budget settles as a `ToolOutcome` error carrying
     * `_tag: "retry_exhausted"` beside its `reason`, with the attempt count and
     * the last attempt's reason as the `attempts` / `last` fields.
     * Omit → the first failure is the outcome.
     */
    readonly retry?: ToolResilience["retry"];
    /**
     * What the model SEES of an `ok` result, as content parts. A screenshot
     * tool whose result is `{ jpeg }` (base64) declares
     * `content: (r) => [{ type: "image", mediaType: "image/jpeg", source: { type: "base64", data: r.jpeg } }]`.
     * The parts ride on the `tool` message beside the outcome, so an adapter
     * sends them instead of stringifying the result. PURE: it runs on every
     * render, over the result as the `Store` hands it back, and never on a
     * failure. Omit → the model reads the outcome as data, as before.
     */
    readonly content?: (result: Ok) => readonly ContentPart[];
  },
  handler: ToolHandler<Args, Ok, TaggedError<Tags[number]>, Ctx>,
): ToolDef<Name, Args, Ok, TaggedError<Tags[number] | "thrown">, Ctx> {
  const settle: ToolConstructors<Ok, TaggedError<Tags[number]>> = {
    ok: Outcome.ok,
    fail: Outcome.err,
  };
  return definedTool<Name, Args, Ok, TaggedError<Tags[number] | "thrown">, Ctx>(
    "tool",
    name,
    spec,
    spec.err,
    (cmd, ctx) => handler(cmd.args, ctx, settle),
  );
}

// ===========================================================================
// toolRouter() — the set: one toolOf, one interpret table, one fold.
// ===========================================================================

/**
 * A call the router could not hand to a tool: the model named a tool nobody
 * declared, or its `args` failed the tool's `input` schema. `toolOf` is total —
 * it never throws inside the reducer — so the refusal rides its own Cmd and
 * settles `tool_rejected_err`, which the loop folds like any tool failure.
 */
export type ToolRejection =
  | { readonly _tag: "unknown_tool"; readonly name: string }
  | {
      readonly _tag: "malformed_args";
      readonly name: string;
      readonly issues: ReadonlyArray<{
        readonly path: string;
        readonly message: string;
      }>;
    };

const rejected = Cmd.define(REJECTED_TYPE, {
  input: unchecked<{
    readonly callId: string;
    readonly error: ToolRejection;
  }>(),
  ok: rejectAll,
  err: ["unknown_tool", "malformed_args"],
});

/** The Cmd `tool_rejected` builds — the router-owned variant of `ToolCmd`. */
export type ToolRejectedCmd = CmdOf<typeof rejected>;

/** The Cmd union a router's `toolOf` produces — `TC` for `createAgent`. */
export type ToolCmd<T extends AnyToolDef> = CmdOf<T> | ToolRejectedCmd;

/** The ctx one tool's handler reads; `unknown` for a handler that reads none. */
type ToolCtxOf<T> = T extends { readonly __ctx?: infer Ctx } ? Ctx : unknown;

type UnionToIntersection<U> = (
  U extends unknown
    ? (u: U) => void
    : never
) extends (u: infer I) => void
  ? I
  : never;

// `unknown` absorbs a union (`{ kb } | unknown` is `unknown`), so each tool's
// ctx is boxed first and the "reads nothing" arms dropped before intersecting.
type ToolCtxBoxed<T> = T extends unknown ? [ToolCtxOf<T>] : never;
type KnownToolCtx<B> = B extends [infer Ctx]
  ? unknown extends Ctx
    ? never
    : Ctx
  : never;

/**
 * The ctx a tool set's handlers read, intersected — what `run` asks the host
 * for once the tools are wired into a machine. A tool whose handler reads
 * nothing leaves its siblings' demand intact.
 */
export type ToolsCtx<T extends AnyToolDef> = UnionToIntersection<
  KnownToolCtx<ToolCtxBoxed<T>>
>;

/** The settled Msg union a router's handlers return — folded by `toMachine`. */
export type ToolMsg<T extends AnyToolDef> =
  | Settled<T>
  | Settled<typeof rejected>;

/**
 * `ToolCmd<T>` as `toMachine` reads it: `never` for `T = never` — the "no
 * router" reading it defaults to — so the router-owned `tool_rejected` arm
 * does not leak into a machine that wired no router.
 */
export type WiredToolCmd<T extends AnyToolDef> = [T] extends [never]
  ? never
  : ToolCmd<T>;

/** `ToolMsg<T>` as `toMachine` / `agentEvents` read it — see `WiredToolCmd`. */
export type WiredToolMsg<T extends AnyToolDef> = [T] extends [never]
  ? never
  : ToolMsg<T>;

/** The union of every tool's `ok` value — `R` for `createAgent`. */
export type ToolResult<T extends AnyToolDef> = OkOf<T>;

/**
 * Every failure a router over `T` can settle with — the union `outcomeOf`'s
 * error arm is typed from. Five sources, and a consumer branching on `_tag`
 * meets all five: each tool's DECLARED tags plus the `thrown` `tool()` appends
 * (`ErrOf<T>`), the kernel's `malformed_result` (a handler returned a value its
 * own `ok` schema rejects), the router's own `unknown_tool` / `malformed_args`
 * rejections, and the ladder's `timeout` / `retry_exhausted` (#117) — which end
 * a call from outside the handler and so are nothing a tool can declare.
 */
export type ToolError<T extends AnyToolDef> =
  | ErrOf<T>
  | MalformedResult
  | ToolRejection
  | ToolResilienceError;

/**
 * The error outcome a router over `T` produces: `{ kind: "error", _tag,
 * …payload, reason }`, discriminable on `_tag` over {@link ToolError}. This is
 * what `defineAgent`'s `onToolError` hands the consumer.
 */
export type ToolFailureOf<T extends AnyToolDef> = TaggedFailure<ToolError<T>>;

/** One settled tool, read back off a `ToolMsg` by `outcomeOf`. */
export type ToolSettlement<R, E extends Tagged = Tagged> = {
  readonly callId: string;
  readonly outcome:
    | { readonly kind: "ok"; readonly result: R }
    | TaggedFailure<E>;
};

/**
 * What `toolRouter()` returns: the derived `toolOf` for `createAgent`'s config,
 * the interpret table `toMachine({ tools })` merges, the defs it puts on
 * `Machine.cmds`, and the one reader that turns a settled Msg back into the
 * conversation's `ToolOutcome`.
 */
export interface ToolRouter<T extends AnyToolDef> {
  /** Every def the router settles through — hand to `Machine.cmds`. */
  readonly defs: readonly AnyCmdDef[];
  /** The `toolOf` for `createAgent`: total, pure, parses `args` at the edge. */
  readonly toolOf: (call: ToolCall) => ToolCmd<T>;
  /** One interpret handler per tool plus the `tool_rejected` handler. */
  readonly interpret: Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>>;
  /**
   * The timeout / retry knob the called tool declared — `AgentConfigCore`'s
   * `toolResilienceOf` seam, filled from the `tool()` specs. `null` for a tool
   * that declared neither field and for a call no tool answers (the rejection
   * path settles in the reducer and never runs an effect to time out). PURE.
   */
  readonly resilienceOf: (call: ToolCall) => ToolResilience | null;
  /**
   * The parts the model reads for one settled call: the called tool's
   * `content` over an `ok` result. `null` for a failure, for a tool that
   * declared no `content`, and for a call no tool answers. PURE.
   */
  readonly partsOf: (
    call: ToolCall,
    outcome: ToolOutcome<unknown>,
  ) => readonly ContentPart[] | null;
  /**
   * Read a settled tool off a Msg: `null` when the Msg is not one of this
   * router's `<name>_ok` / `<name>_err`. The one place a `{ _tag }` failure is
   * rendered to the `reason` string the conversation carries — and the tag and
   * its payload ride beside that rendering, never instead of it (#115).
   */
  readonly outcomeOf: (msg: {
    readonly type: string;
  }) => ToolSettlement<ToolResult<T>, ToolError<T>> | null;
}

/**
 * Fold a set of `tool()`s into one router — pass it the tools, get back the
 * lookup `createAgent` needs, the handlers `toMachine` merges, and a reader that
 * turns a settled message back into a plain outcome.
 *
 * Two tools with one name is a declaration bug, refused here rather than by a
 * silent last-wins map.
 */
export function toolRouter<T extends AnyToolDef>(
  tools: readonly T[],
): ToolRouter<T> {
  const byName = new Map<string, T>();
  for (const t of tools) {
    if (byName.has(t.cmdType)) {
      throw new Error(`toolRouter: tool "${t.cmdType}" is declared twice`);
    }
    byName.set(t.cmdType, t);
  }
  const defs: readonly AnyCmdDef[] = [...tools, rejected];
  const okTypes = new Map(defs.map((d) => [d.okType, d]));
  const errTypes = new Map(defs.map((d) => [d.errType, d]));

  const toolOf = (call: ToolCall): ToolCmd<T> => {
    const t = byName.get(call.name);
    if (t === undefined) {
      return rejected({
        callId: call.callId,
        error: { _tag: "unknown_tool", name: call.name },
      });
    }
    const parsed = validateSync(
      t.args,
      call.args,
      `the "${call.name}" tool's input schema`,
    );
    if (parsed.issues !== undefined) {
      return rejected({
        callId: call.callId,
        error: {
          _tag: "malformed_args",
          name: call.name,
          issues: malformedResult(parsed.issues).issues,
        },
      });
    }
    // `t` is the def the name resolved to, so its constructor builds exactly
    // the `CmdOf<T>` arm for that name; `AnyToolDef` erases the call signature.
    const build = t as unknown as (input: ToolInput<unknown>) => CmdOf<T>;
    return build({ callId: call.callId, args: parsed.value });
  };

  const handlers: Record<string, unknown> = {
    [rejected.cmdType]: async (cmd: ToolRejectedCmd) => Outcome.err(cmd.error),
  };
  for (const t of tools) handlers[t.cmdType] = t.interpret;
  // Each handler is the def's own typed `interpret`, keyed by the `type` it
  // builds; the record is assembled per name, which the mapped type cannot see.
  const interpret = handlers as unknown as Interpret<
    ToolMsg<T>,
    ToolCmd<T>,
    ToolsCtx<T>
  >;

  const outcomeOf = (msg: {
    readonly type: string;
  }): ToolSettlement<ToolResult<T>, ToolError<T>> | null => {
    if (okTypes.has(msg.type)) {
      const ok = msg as unknown as SettledShape<ToolResult<T>>;
      return {
        callId: ok.cmd.callId,
        outcome: { kind: "ok", result: ok.value },
      };
    }
    if (errTypes.has(msg.type)) {
      const err = msg as unknown as SettledShape<ToolResult<T>>;
      return {
        callId: err.cmd.callId,
        // The tag and its payload spread FIRST, so `kind` and `reason` are
        // written over anything a payload field of those names carries: the
        // discriminant and the model's channel are the router's to state, and a
        // tool that fails with `{ _tag, kind: "ok" }` must not be able to say
        // otherwise.
        outcome: {
          ...err.error,
          reason: toolErrorReason(err.error),
          kind: "error",
        } as TaggedFailure<ToolError<T>>,
      };
    }
    return null;
  };

  const resilienceOf = (call: ToolCall): ToolResilience | null =>
    byName.get(call.name)?.resilience ?? null;

  const partsOf = (
    call: ToolCall,
    outcome: ToolOutcome<unknown>,
  ): readonly ContentPart[] | null => {
    const content = byName.get(call.name)?.content ?? null;
    if (content === null || outcome.kind !== "ok") return null;
    // The result settled through this tool's own `ok` schema, so it is the
    // `Ok` the projection was declared over; `AnyToolDef` erases it to `never`.
    return (content as (result: unknown) => readonly ContentPart[])(
      outcome.result,
    );
  };

  return { defs, toolOf, interpret, outcomeOf, resilienceOf, partsOf };
}

// ===========================================================================
// fanOutInterpret() — ADR 0018 option (c): overlap INSIDE the Cmd handler.
// ===========================================================================

/** One interpret cell, erased of its per-tool narrowing. */
type AnyCell = (
  cmd: never,
  ctx: never,
  dispatch?: (msg: never) => void,
) => Promise<unknown>;

/**
 * Give a router's interpret cells real wall-clock overlap without touching the
 * kernel — pass the table `toolRouter` built, get back one whose cells launch
 * their tool and RETURN, so `runInterpret` reaches the next Cmd of the turn
 * while the first tool is still running.
 *
 * This is ADR 0018's option (c), and the whole of it. `runInterpret` stays the
 * serial loop the ADR ruled it must be: it still awaits one handler before
 * reaching the next Cmd — the handlers just stop being the thing that takes the
 * time. Three properties are what make that safe, and each is a line below:
 *
 * - **Settles fold in Cmd-EMISSION order, never completion order.** Each cell
 *   chains its dispatch behind the previous cell's, so two tools that overlap
 *   on the clock still settle a-then-b when a's Cmd was emitted first, whichever
 *   finished first. That is invariant 2's serializability, and it is what keeps
 *   a replay of a fanned run identical to the run itself.
 * - **The settle crosses the SAME edge.** A returned Msg is parsed and stamped
 *   by `run`'s `cmdEdge`; a dispatched one would not be, so the cell settles
 *   through `cmdEdgeOf(ctx)` — the edge `run` hands handlers for exactly this.
 *   One parse, one clock, fanned or not.
 * - **The work stays counted.** The promise the cell does not return is enlisted
 *   with `detachWorkOf(ctx)`, so `inFlightCmds` and the dispatch tail see it and
 *   `stop()` / `idle()` answer under fan-out what they answer serially.
 *
 * The ordering has a price, and it is the honest one: a call whose Cmd was
 * emitted FIRST holds its siblings' settles until it finishes. They still RUN
 * in parallel — the turn costs the slowest call, not the sum — but a first call
 * that never returns leaves the later folds parked behind it, exactly as a
 * serial run would leave them unstarted. `timeoutMs` on the tool is what bounds
 * that, fanned or not.
 *
 * The per-turn LIMIT is not this function's: the agent's fan-out slice already
 * launches at most `toolConcurrency` calls per transition, so the table simply
 * must not block. Nothing here is applied below that knob — `toMachine` wires
 * the bare cells at the serial default, and a tool that never overlaps is the
 * exact function `toolRouter` built.
 */
export function fanOutInterpret<T extends AnyToolDef>(
  interpret: Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>>,
): Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>> {
  // The release chain: one per table, so the ordering it imposes is the
  // ordering of the Cmds that entered THIS machine's interpret.
  let release: Promise<void> = Promise.resolve();
  const fanned: Record<string, AnyCell> = {};
  for (const [type, cell] of Object.entries(
    interpret as unknown as Record<string, AnyCell>,
  )) {
    fanned[type] = async (cmd, ctx, dispatch) => {
      const edge = cmdEdgeOf(ctx);
      const detach = detachWorkOf(ctx);
      // Launched, NOT awaited — this one line is the overlap.
      const work = (async () => cell(cmd, ctx, dispatch))();
      const prior = release;
      const settled = work.then(async (follow) => {
        // The wait is here rather than before `work` so the tools overlap and
        // only their SETTLES queue: a tool whose Cmd came second still starts
        // at once and merely waits its turn to fold.
        await prior;
        const msg = edge(cmd, follow);
        if (msg === undefined || msg === null) return;
        dispatch?.(msg as never);
      });
      // A rejecting cell must not strand the tools behind it — `detach` is what
      // routes that rejection to the runtime's sink.
      release = settled.then(swallow, swallow);
      detach(settled);
      return undefined;
    };
  }
  return fanned as unknown as Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>>;
}

/** The release chain carries no value and must not break — both arms land here. */
function swallow(): void {}

// The two settled arms share one shape once the `type` has been matched
// against the router's own def; `value` / `error` are read per arm.
type SettledShape<R> = {
  readonly cmd: { readonly callId: string };
  readonly value: R;
  readonly error: Tagged;
};

/**
 * Turn a tool failure into the human-readable reason string the conversation
 * carries — pass the `{ _tag, ...detail }` a tool failed with, get the tag
 * followed by any remaining detail as JSON.
 *
 * The
 * model reads this next turn, so the data survives the rendering intact.
 */
export function toolErrorReason(error: Tagged): string {
  const { _tag, ...detail } = error;
  return Object.keys(detail).length === 0
    ? _tag
    : `${_tag} ${JSON.stringify(detail)}`;
}
