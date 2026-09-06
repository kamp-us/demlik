/**
 * @demlik/tea/agent — `tool()` + `toolRouter()`: declare a tool once and derive
 * what a consumer used to hand-write twice — the `toolOf` mapping from a
 * model's `ToolCall` to an effect Cmd, and the interpret cell that runs the
 * handler and settles it (#56).
 *
 * A tool is a `Cmd.define`d effect (#44) whose input is the model's call —
 * `{ callId, args }` — with the handler colocated on the constructor. The
 * router folds a set of them into one `toolOf` and one interpret table; the
 * cells settle through the minted `<name>_ok` / `<name>_err` Msgs, errors as
 * `{ _tag }` data (ADR 0011). `createAgent(...).toMachine({ tools })` folds
 * those settles into the conversation, so a consumer names nothing twice.
 */

import { Result } from "better-result";
import { z } from "zod";
import { describeError } from "../describe-error";
import {
  type AnyCmdDef,
  Cmd,
  type CmdDef,
  type CmdOf,
  type CmdValue,
  type Interpret,
  type Needs,
  type NoCtx,
  type OkOf,
  type PortEmitter,
  type Settled,
  type Tagged,
  type TaggedError,
} from "../index";
import { MsgType, type MsgTypeValue } from "../protocol";
import { malformedResult } from "../pure/core";
import type { ToolCall, ToolOutcome } from "./types";

// ===========================================================================
// Reserved names — the agent's own Msg vocabulary a tool may not mint over.
// ===========================================================================

/**
 * The prefix a protocol discriminant was minted from: `resilient_ok` →
 * `resilient`, `compact_run` → `compact`. A tool named by that prefix would
 * mint the same `<name>_ok` / `<name>_err` the agent's reducer already owns.
 */
type SettlePrefixOf<T extends string> = T extends
  | `${infer P}_ok`
  | `${infer P}_err`
  | `${infer P}_run`
  ? P
  : never;

const REJECTED_TYPE = "tool_rejected";
const SNAPSHOT_WRITE_TYPE = "snapshot_write";

/**
 * A tool name `tool()` refuses (#72). A tool's name is its Cmd `type` — so
 * its interpret key — and the prefix of its settle Msgs, so every string
 * already spoken by the protocol is taken twice over: the settle prefixes
 * (`resilient`, `agent_tool`, `compact`) would overwrite the agent's own
 * reducer cells through `toMachine`'s last-wins spread, and the discriminants
 * themselves (`compact_run`, `resilient_run`, …) would shadow the interpret
 * cell of that name. Both halves derive from `MsgType`: a new entry there
 * reserves its name and its prefix with no second edit. The two names outside
 * the protocol are the router's own `tool_rejected` and the checkpoint cell
 * `snapshot_write`, which `toMachine` merges under the consumer's key.
 */
export type ReservedToolName =
  | MsgTypeValue
  | SettlePrefixOf<MsgTypeValue>
  | typeof REJECTED_TYPE
  | typeof SNAPSHOT_WRITE_TYPE;

/**
 * Widens to `unknown` for a name outside the reserved set and to `never`
 * inside it, so `Name & NotReserved<Name>` is the name itself or
 * unconstructible. A widened `string` passes here — the runtime check in
 * `tool()` is what catches a reserved name built from one.
 */
type NotReserved<Name extends string> = Name extends ReservedToolName
  ? never
  : unknown;

const SETTLE_SUFFIX = /_(?:ok|err|run)$/;

/** The runtime mirror of `ReservedToolName`, read off the same `MsgType`. */
const reservedToolNames: ReadonlySet<string> = new Set<string>([
  ...Object.values(MsgType),
  ...Object.values(MsgType).flatMap((t) => {
    const suffix = SETTLE_SUFFIX.exec(t);
    return suffix === null ? [] : [t.slice(0, suffix.index)];
  }),
  REJECTED_TYPE,
  SNAPSHOT_WRITE_TYPE,
]);

/** Whether `name` is one `tool()` refuses — the set `ReservedToolName` types. */
export function isReservedToolName(name: string): name is ReservedToolName {
  return reservedToolNames.has(name);
}

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
 * the model sees as a reason, never a rejection out of the interpret cell.
 */
export type ToolThrown = { readonly _tag: "thrown"; readonly message: string };

/**
 * The typed success constructor a handler receives: `ok(value)` with `Ok`
 * fixed to what the `ok` schema parses, so a value of the wrong shape is
 * refused where it is written.
 */
export type ToolOk<Ok, E extends Tagged> = (value: Ok) => Result<Ok, E>;

/**
 * The typed failure constructor a handler receives: `fail({ _tag })` with `E`
 * fixed to the declared tags, so the literal is checked against them where it
 * is written. (A bare `{ _tag: "x" }` built elsewhere infers `_tag: string`
 * and cannot be — the parameter type is what keeps it literal.)
 */
export type ToolFail<Ok, E extends Tagged> = (error: E) => Result<Ok, E>;

/**
 * The two constructors a handler is handed, one per channel — `ok` for the
 * value the `ok` schema parses, `fail` for a declared `{ _tag }`. Both are
 * tea's, so a handler settles either arm without naming the result library
 * underneath (#94).
 */
export type ToolConstructors<Ok, E extends Tagged> = {
  readonly ok: ToolOk<Ok, E>;
  readonly fail: ToolFail<Ok, E>;
};

/**
 * A tool's handler: the parsed `args`, the ctx slice `needs` named, and the
 * typed `{ ok, fail }`, to a result over the declared channels — `Ok` is what
 * the `ok` schema parses, `E` the declared `_tag` union. An undeclared tag
 * does not compile.
 */
export type ToolHandler<Args, Ok, E extends Tagged, R> = (
  args: Args,
  ctx: R & PortEmitter,
  settle: ToolConstructors<Ok, E>,
) => Promise<Result<Ok, E>>;

/**
 * What `tool()` returns: the `Cmd.define`d constructor (so `Settled<typeof t>`
 * / `CmdOf<typeof t>` read it like any def) plus the colocated `interpret` cell,
 * the bare `args` schema the router parses a call against, and the
 * `description` a provider adapter declares to the model beside that schema.
 * `E` is the full failure union the Cmd settles with — the declared tags plus
 * `thrown`.
 */
export type ToolDef<
  Name extends string,
  Args,
  Ok,
  E extends Tagged,
  R,
> = CmdDef<Name, ToolInput<Args>, Ok, E, R> & {
  readonly description: string;
  readonly args: z.ZodType<Args>;
  readonly interpret: (
    cmd: CmdValue<Name, ToolInput<Args>, E, R>,
    ctx: R & PortEmitter,
  ) => Promise<Settled<CmdDef<Name, ToolInput<Args>, Ok, E, R>>>;
};

/** The declaration-erased view the router reads. */
export type AnyToolDef = AnyCmdDef & {
  readonly description: string;
  readonly args: z.ZodType;
  readonly interpret: (cmd: never, ctx: never) => Promise<unknown>;
};

/**
 * Declare one tool. `name` is the Cmd `type` and the name the model calls it
 * by; `description` is the model-facing sentence — the one place it lives — a
 * provider adapter declares to the model beside the schema (Anthropic
 * `description`, OpenAI `function.description`) so the model can tell when to
 * call the tool, read off `def.description`, never off the `input` schema;
 * `input` parses the model's `args`; `ok` parses the handler's value at the
 * edge; `err` is the `_tag` list the handler may fail with; `needs` is the ctx
 * slice it reads, demanded at `run`. The handler returns one of the two
 * constructors it is handed — `ok(value)` or the typed `fail({ _tag })`; a
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
  R = unknown,
>(
  name: Name & NotReserved<Name>,
  spec: {
    readonly description: string;
    readonly input: z.ZodType<Args>;
    readonly ok: z.ZodType<Ok>;
    readonly err: Tags;
    readonly needs?: Needs<R>;
  },
  handler: ToolHandler<Args, Ok, TaggedError<Tags[number]>, R>,
): ToolDef<Name, Args, Ok, TaggedError<Tags[number] | "thrown">, R> {
  if (isReservedToolName(name)) {
    throw new Error(
      `tool: "${name}" is reserved — it is an agent-owned Msg prefix`,
    );
  }
  type E = TaggedError<Tags[number] | "thrown">;
  type Def = CmdDef<Name, ToolInput<Args>, Ok, E, R>;
  const def: Def = Cmd.define(name as Name, {
    input: z.object({
      callId: z.string(),
      args: spec.input,
    }) as z.ZodType<ToolInput<Args>>,
    ok: spec.ok,
    err: [...spec.err, "thrown"] as readonly (Tags[number] | "thrown")[],
    needs: spec.needs,
  });
  type C = CmdValue<Name, ToolInput<Args>, E, R>;
  const declared = new Set<string>(spec.err);
  const settle: ToolConstructors<Ok, TaggedError<Tags[number]>> = {
    ok: (value) => Result.ok(value),
    fail: (error) => Result.err(error),
  };
  const asDeclared = (thrown: unknown): E => {
    if (isTagged(thrown) && declared.has(thrown._tag)) return thrown as E;
    return { _tag: "thrown", message: describeError(thrown) };
  };
  const interpret = async (
    cmd: C,
    ctx: R & PortEmitter,
  ): Promise<Settled<Def>> => {
    let result: Result<Ok, TaggedError<Tags[number]>>;
    try {
      result = await handler(cmd.args, ctx, settle);
    } catch (thrown) {
      return def.err(cmd, asDeclared(thrown));
    }
    return result.match({
      ok: (value): Settled<Def> => {
        // The same parse `run`'s edge applies when the def is on
        // `Machine.cmds` — done here too so the cell is honest on its own.
        // `at` is the runtime's to stamp, exactly as the def's builders leave it.
        const parsed = spec.ok.safeParse(value);
        return parsed.success
          ? def.ok(cmd, parsed.data)
          : ({
              type: def.errType,
              cmd,
              error: malformedResult(parsed.error.issues),
            } as Settled<Def>);
      },
      err: (error) => def.err(cmd, error),
    });
  };
  return Object.assign(def, {
    description: spec.description,
    args: spec.input,
    interpret,
  });
}

function isTagged(value: unknown): value is Tagged {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { _tag?: unknown })._tag === "string"
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
  input: z.custom<{ readonly callId: string; readonly error: ToolRejection }>(
    () => true,
  ),
  ok: z.never(),
  err: ["unknown_tool", "malformed_args"],
});

/** The Cmd `tool_rejected` builds — the router-owned variant of `ToolCmd`. */
export type ToolRejectedCmd = CmdOf<typeof rejected>;

/** The Cmd union a router's `toolOf` produces — `TC` for `createAgent`. */
export type ToolCmd<T extends AnyToolDef> = CmdOf<T> | ToolRejectedCmd;

/** The settled Msg union a router's cells return — folded by `toMachine`. */
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

/** One settled tool, read back off a `ToolMsg` by `outcomeOf`. */
export type ToolSettlement<R> = {
  readonly callId: string;
  readonly outcome: ToolOutcome<R>;
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
  /** One interpret cell per tool plus the `tool_rejected` cell. */
  readonly interpret: Interpret<ToolMsg<T>, ToolCmd<T>, NoCtx>;
  /**
   * Read a settled tool off a Msg: `null` when the Msg is not one of this
   * router's `<name>_ok` / `<name>_err`. The one place a `{ _tag }` failure is
   * rendered to the `reason` string the conversation carries.
   */
  readonly outcomeOf: (msg: {
    readonly type: string;
  }) => ToolSettlement<ToolResult<T>> | null;
}

/**
 * Fold a set of `tool()`s into one router. Two tools with one name is a
 * declaration bug, refused here rather than by a silent last-wins map.
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
    const parsed = t.args.safeParse(call.args);
    if (!parsed.success) {
      return rejected({
        callId: call.callId,
        error: {
          _tag: "malformed_args",
          name: call.name,
          issues: malformedResult(parsed.error.issues).issues,
        },
      });
    }
    // `t` is the def the name resolved to, so its constructor builds exactly
    // the `CmdOf<T>` arm for that name; `AnyToolDef` erases the call signature.
    const build = t as unknown as (input: ToolInput<unknown>) => CmdOf<T>;
    return build({ callId: call.callId, args: parsed.data });
  };

  const cells: Record<string, unknown> = {
    [rejected.cmdType]: async (cmd: ToolRejectedCmd) =>
      rejected.err(cmd, cmd.error),
  };
  for (const t of tools) cells[t.cmdType] = t.interpret;
  // Each cell is the def's own typed `interpret`, keyed by the `type` it
  // builds; the record is assembled per name, which the mapped type cannot see.
  const interpret = cells as unknown as Interpret<
    ToolMsg<T>,
    ToolCmd<T>,
    NoCtx
  >;

  const outcomeOf = (msg: {
    readonly type: string;
  }): ToolSettlement<ToolResult<T>> | null => {
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
        outcome: { kind: "error", reason: toolErrorReason(err.error) },
      };
    }
    return null;
  };

  return { defs, toolOf, interpret, outcomeOf };
}

// The two settled arms share one shape once the `type` has been matched
// against the router's own def; `value` / `error` are read per arm.
type SettledShape<R> = {
  readonly cmd: { readonly callId: string };
  readonly value: R;
  readonly error: Tagged;
};

/**
 * Render a settled `{ _tag }` failure as the `reason` string the conversation
 * carries — the tag, then the detail beside it as JSON when there is any. The
 * model reads this next turn, so the data survives the rendering intact.
 */
export function toolErrorReason(error: Tagged): string {
  const { _tag, ...detail } = error;
  return Object.keys(detail).length === 0
    ? _tag
    : `${_tag} ${JSON.stringify(detail)}`;
}
