/**
 * @demlik/tea/agent — the one construction every tool definition goes through.
 *
 * NOT part of the public `./agent` barrel. `tool()` and `agentTool()` are two
 * doors onto the same `ToolDef`: `tool()` hands its handler the parsed `args`,
 * and `agentTool()` needs the whole Cmd — `callId` included — because the call's
 * identity is what keys the child run. Both are built here, so the reserved-name
 * refusal, the `thrown` channel and the resilience knob have one definition.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describeError } from "../describe-error";
import {
  Cmd,
  type CmdDef,
  type CmdValue,
  Outcome,
  type Tagged,
} from "../index";
import { unchecked } from "../internal/schema";
import { MsgType, type MsgTypeValue } from "../protocol";
import type { HandlerCtx } from "../pure/core";
import type { ContentPart } from "./content";
import type { ToolDef, ToolInput } from "./tool";
import type { ToolResilience } from "./types";

// ===========================================================================
// Reserved names — the agent's own Msg vocabulary a tool may not mint over.
// ===========================================================================

/**
 * The prefix a protocol discriminant was minted from: `resilient_run_ok` →
 * `resilient_run`, `compact_run` → `compact`. A tool named by that prefix would
 * mint the same `<name>_ok` / `<name>_err` the agent's reducer already owns.
 */
type SettlePrefixOf<T extends string> = T extends
  | `${infer P}_ok`
  | `${infer P}_err`
  | `${infer P}_run`
  ? P
  : never;

export const REJECTED_TYPE = "tool_rejected";
const SNAPSHOT_WRITE_TYPE = "snapshot_write";

/**
 * A tool name `tool()` and `agentTool()` refuse. A tool's name is its Cmd `type` — so
 * its interpret key — and the prefix of its settle Msgs, so every string
 * already spoken by the protocol is taken twice over: the settle prefixes
 * (`resilient_run`, `agent_tool`, `compact`) would overwrite the agent's own
 * reducer handlers through `toMachine`'s last-wins spread, and the discriminants
 * themselves (`compact_run`, `resilient_run`, …) would shadow the interpret
 * handler of that name. `resilient` is reserved as a Cmd prefix — the part
 * before `_run` in the brain Cmd `resilient_run` — not as a settle prefix: its
 * `resilient_ok` / `resilient_err` name nothing the agent settles. Both halves
 * derive from `MsgType`: a new entry there
 * reserves its name and its prefix with no second edit. The two names outside
 * the protocol are the router's own `tool_rejected` and the checkpoint handler
 * `snapshot_write`, which `toMachine` merges under the consumer's key.
 */
export type ReservedToolName =
  | MsgTypeValue
  | SettlePrefixOf<MsgTypeValue>
  | typeof REJECTED_TYPE
  | typeof SNAPSHOT_WRITE_TYPE;

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

/** Whether `name` is one a tool door refuses — the set `ReservedToolName` types. */
export function isReservedToolName(name: string): name is ReservedToolName {
  return reservedToolNames.has(name);
}

/**
 * Widens to `unknown` for a name outside the reserved set and to `never`
 * inside it, so `Name & NotReserved<Name>` is the name itself or
 * unconstructible. A widened `string` passes here — the runtime check in
 * `definedTool` is what catches a reserved name built from one.
 */
export type NotReserved<Name extends string> = Name extends ReservedToolName
  ? never
  : unknown;

/** The spec fields every tool door shares. */
export interface ToolSpec<Args, Ok> {
  readonly description: string;
  readonly input: StandardSchemaV1<unknown, Args>;
  readonly ok: StandardSchemaV1<unknown, Ok>;
  readonly timeoutMs?: number;
  readonly retry?: ToolResilience["retry"];
  readonly content?: (result: Ok) => readonly ContentPart[];
}

/**
 * Build one tool definition from its spec, its declared tags and the cell that
 * runs a call. `E` is the WHOLE failure union the Cmd settles with, `thrown`
 * included: a cell that throws something other than a declared `{ _tag }`
 * settles `{ _tag: "thrown", message }`, never a rejection out of interpret.
 */
export function definedTool<
  Name extends string,
  Args,
  Ok,
  E extends Tagged,
  Ctx,
>(
  door: string,
  name: Name,
  spec: ToolSpec<Args, Ok>,
  declaredTags: readonly string[],
  cell: (
    cmd: CmdValue<Name, ToolInput<Args>, Ok, E>,
    ctx: HandlerCtx<Ctx>,
  ) => Promise<Outcome<Ok, E>>,
): ToolDef<Name, Args, Ok, E, Ctx> {
  if (isReservedToolName(name)) {
    throw new Error(
      `${door}: "${name}" is reserved — it is an agent-owned Msg prefix`,
    );
  }
  // The router parses `args` against `spec.input` before it builds the Cmd,
  // so the Cmd's own input schema only names the type. `Cmd.define` types its
  // failures off the tag list alone; `E` is the richer union the door declared
  // over those same tags, so the def is read at that type.
  const def = Cmd.define(name, {
    input: unchecked<ToolInput<Args>>(),
    ok: spec.ok,
    err: [...declaredTags, "thrown"],
  }) as unknown as CmdDef<Name, ToolInput<Args>, Ok, E>;
  const declared = new Set<string>(declaredTags);
  const asDeclared = (thrown: unknown): E =>
    (isTagged(thrown) && declared.has(thrown._tag)
      ? thrown
      : { _tag: "thrown", message: describeError(thrown) }) as E;
  // A throw is data here, not a contract breach: `thrown` is one of the tool's
  // declared tags, so the engine mints it into `<name>_err` like any other.
  const interpret = async (
    cmd: CmdValue<Name, ToolInput<Args>, Ok, E>,
    ctx: HandlerCtx<Ctx>,
  ): Promise<Outcome<Ok, E>> => {
    try {
      return await cell(cmd, ctx);
    } catch (thrown) {
      return Outcome.err(asDeclared(thrown));
    }
  };
  return Object.assign(def, {
    description: spec.description,
    args: spec.input,
    resilience: resilienceOf(spec),
    content: spec.content ?? null,
    interpret,
  });
}

/**
 * The declared knob as one value, or `null` when neither field was named. The
 * `null` is load-bearing: it is what tells the ladder to leave this tool on the
 * plain fan-out path, so a tool that declares nothing keeps behaving exactly as
 * it did before the knob existed. PURE.
 */
function resilienceOf(spec: {
  readonly timeoutMs?: number;
  readonly retry?: ToolResilience["retry"];
}): ToolResilience | null {
  if (spec.timeoutMs === undefined && spec.retry === undefined) return null;
  return {
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.retry !== undefined ? { retry: spec.retry } : {}),
  };
}

function isTagged(value: unknown): value is Tagged {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { _tag?: unknown })._tag === "string"
  );
}
