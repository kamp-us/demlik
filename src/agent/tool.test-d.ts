// Type-level test for `tool()` + `toolRouter()` (#56). Compiled by
// `pnpm typecheck` (tsc over `src/**` INCLUDES `*.test-d.ts`). Every
// `@ts-expect-error` MUST sit on a line that genuinely fails to type-check;
// every undirected line is a positive case that must compile.
//
// The three contracts:
//   1. A handler may fail only with a DECLARED `_tag` — an undeclared one is a
//      compile error; the settled `_err` arm carries declared + `thrown` +
//      the kernel's `malformed_result`.
//   2. `toolOf` / `interpret` are derived — nothing per tool is hand-written,
//      and `toMachine({ tools })` leaves no tool cell on `toolInterpret`.
//   3. A `needs` slice a tool names is demanded at `run` — a ctx without it
//      does not compile.
//   4. A reserved name — an agent-owned Msg prefix or discriminant — does not
//      compile as `tool()`'s `name` (#72); the set derives from `MsgType`.
//   5. `description` is required on the spec and read back off the def (#91).

import { z } from "zod";
import { absurd, Cmd, type PortEmitter, run, type Settled } from "../index";
import type { MsgTypeValue } from "../protocol";
import {
  type AgentTurn,
  type AnyToolDef,
  createAgent,
  defineAgent,
  type ReservedToolName,
  type Schema,
  type ToolCmd,
  type ToolConstructors,
  type ToolResult,
  tool,
  toolRouter,
} from "./index";

type Kb = { readonly lookup: (q: string) => string | undefined };
type KbCtx = { readonly kb: Kb };

// ── 1. failures are the declared tags, checked at the handler ───────────────

const search = tool(
  "search",
  {
    description: "Look a phrase up in the knowledge base.",
    input: z.object({ q: z.string() }),
    ok: z.object({ snippet: z.string() }),
    err: ["not_found", "rate_limited"],
    requirements: Cmd.requirements<KbCtx>(),
  },
  async ({ q }, ctx, { ok, fail }) => {
    // The `R` slice lands on the handler's ctx: `ctx.kb` is typed.
    const snippet = ctx.kb.lookup(q);
    if (snippet === undefined) return fail({ _tag: "not_found" });
    // Detail rides beside the tag.
    if (q === "") return fail({ _tag: "rate_limited", afterMs: 250 });
    return ok({ snippet });
  },
);

tool(
  "leaky",
  { description: "d", input: z.object({}), ok: z.void(), err: ["not_found"] },
  // @ts-expect-error `timeout` is not a declared tag
  async (_args, _ctx, { fail }) => fail({ _tag: "timeout" }),
);

tool(
  "wrong_ok",
  {
    description: "d",
    input: z.object({}),
    ok: z.object({ n: z.number() }),
    err: [],
  },
  // @ts-expect-error the ok value must be what the `ok` schema parses
  async (_args, _ctx, { ok }) => ok({ n: "one" }),
);

// The settled `_err` arm is exhaustive over declared + `thrown` + the kernel's
// `malformed_result`; dropping one leaves `absurd` a non-`never`.
type SearchSettled = Settled<typeof search>;
function reasonOf(msg: Extract<SearchSettled, { type: "search_err" }>): string {
  const error = msg.error;
  switch (error._tag) {
    case "not_found":
    case "rate_limited":
    case "thrown":
    case "malformed_result":
      return error._tag;
    default:
      return absurd(error);
  }
}
void reasonOf;

function missingThrown(
  msg: Extract<SearchSettled, { type: "search_err" }>,
): string {
  const error = msg.error;
  switch (error._tag) {
    case "not_found":
    case "rate_limited":
    case "malformed_result":
      return error._tag;
    default:
      // @ts-expect-error `thrown` is unhandled, so `error` is not `never`
      return absurd(error);
  }
}
void missingThrown;

// The `_ok` arm carries the parsed `ok` value and the Cmd that produced it.
function snippetOf(msg: Extract<SearchSettled, { type: "search_ok" }>): string {
  const q: string = msg.cmd.args.q;
  const callId: string = msg.cmd.callId;
  void q;
  void callId;
  return msg.value.snippet;
}
void snippetOf;

// ── 2. the router derives toolOf + interpret; toMachine takes them whole ────

const count = tool(
  "count",
  {
    description: "Count the items handed in.",
    input: z.object({ items: z.array(z.string()) }),
    ok: z.number(),
    err: [],
  },
  async ({ items }, _ctx, { ok }) => ok(items.length),
);

const tools = toolRouter([search, count]);

// `TC` and `R` for the agent are read off the tool set — nothing named twice.
type Tool = typeof search | typeof count;
type R = ToolResult<Tool>;
const okValues: R[] = [{ snippet: "s" }, 3];
void okValues;

type Stage = "plan";
type Purpose = "plan_turn";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly plan_turn: AgentTurn;
}
const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };

const agent = createAgent<Stage, Purpose, Outputs, R, ToolCmd<Tool>, unknown>({
  stages: ["plan"],
  model: () => ({
    withStructuredOutput: <T>(_s: Schema<T>) => ({
      invoke: async () => ({ content: "", toolCalls: [] }) as T,
    }),
  }),
  schemas: { plan_turn: turnSchema },
  turnOf: () => "plan_turn",
  toolOf: tools.toolOf,
});

// With the router wired, `toolInterpret` owes nothing: every tool cell is the
// router's, snapshotting and compaction are off.
const machine = agent.toMachine({ tools });

// Without the router, the consumer still owes a cell per tool Cmd — the
// pre-#56 contract is unchanged.
// @ts-expect-error `search` / `count` / `tool_rejected` cells are missing
agent.toMachine({ toolInterpret: {} });

// A router-settled Msg is on the machine's `M`.
const settledOnM: Parameters<typeof machine.update.search_ok>[1] = search.ok(
  search({ callId: "c", args: { q: "tea" } }),
  { snippet: "s" },
  1,
);
void settledOnM;

// The router's cells are plain `Interpret` cells over the tool Cmd.
const cell: (
  cmd: ReturnType<typeof search>,
  ctx: KbCtx & PortEmitter,
) => Promise<unknown> = tools.interpret.search;
void cell;

// ── 3. `run` demands every tool's `needs` on ctx ────────────────────────────

const kb: Kb = { lookup: () => undefined };

// POSITIVE: the slice `search` needs is supplied.
run(machine, { ctx: { kb } });

// NEGATIVE: `search` names `kb`; a ctx without it does not compile.
// @ts-expect-error ctx lacks `kb`
run(machine, { ctx: {} });
// @ts-expect-error ctx cannot be omitted while a tool names a requirement
run(machine, {});

// ── 4. a reserved name does not compile (#72) ───────────────────────────────

const spec = {
  description: "Do nothing; exists only to test the reserved-name refusal.",
  input: z.object({}),
  ok: z.void(),
  err: [],
} as const;
const noop = async (
  _args: object,
  _ctx: PortEmitter,
  { ok }: ToolConstructors<void, never>,
) => ok(undefined);

// The four the reviewer hit: the settle prefixes the agent's reducer owns, and
// the router's own rejection def.
// @ts-expect-error `agent_tool` mints `agent_tool_ok` / `agent_tool_err`
tool("agent_tool", spec, noop);
// @ts-expect-error `resilient` mints `resilient_ok` / `resilient_err`
tool("resilient", spec, noop);
// @ts-expect-error `compact` mints `compact_ok` / `compact_err`
tool("compact", spec, noop);
// @ts-expect-error `tool_rejected` is the router's own def
tool("tool_rejected", spec, noop);

// The discriminants themselves are interpret keys `toMachine` merges under.
// @ts-expect-error `compact_run` is the consumer's compaction cell
tool("compact_run", spec, noop);
// @ts-expect-error `resilient_run` is the brain cell
tool("resilient_run", spec, noop);
// @ts-expect-error `snapshot_write` is the checkpoint cell
tool("snapshot_write", spec, noop);

// A name beside the reserved ones still compiles, and keeps its literal.
const compactor = tool("compactor", spec, noop);
const compactorType: "compactor" = compactor.cmdType;
void compactorType;

// The set is `MsgType`'s: every discriminant is reserved, and so is the prefix
// each `_ok` / `_err` / `_run` entry was minted from.
const everyDiscriminant: MsgTypeValue extends ReservedToolName ? true : false =
  true;

// ── 5. `description` is the model-facing slot — required, read back (#91) ───

const described: string = search.description;
void described;
const anyDescribed: string = (search as AnyToolDef).description;
void anyDescribed;

tool(
  "undescribed",
  // @ts-expect-error `description` is required — a tool the model cannot tell when to call is a declaration bug
  { input: z.object({}), ok: z.void(), err: [] },
  noop,
);
const everyPrefix:
  | "resilient"
  | "agent_tool"
  | "compact" extends ReservedToolName
  ? true
  : false = true;
void everyDiscriminant;
void everyPrefix;

// ── 6. a failure's `_tag` is a TYPE the consumer switches on (#115) ─────────
//
// The outcome `onToolError` receives is the declared tags, distributed over
// `{ kind, reason }` — so a `switch` on `_tag` narrows the payload and covering
// every arm leaves `never`. The union is wider than what one tool declares, and
// deliberately: `thrown` is on every tool, `malformed_result` is the kernel's,
// and `unknown_tool` / `malformed_args` are the router's. A consumer who
// handles only their own tags has not handled a failure the run can produce.

const flaky = tool(
  "flaky",
  {
    description: "Fails in two declared ways.",
    input: z.object({}),
    ok: z.string(),
    err: ["a", "b"],
  },
  async (_args, _ctx, { ok }) => ok("fine"),
);

defineAgent({
  model: async () => ({ content: "", toolCalls: [] }),
  tools: [flaky],
  instructions: "",
  onToolError: (outcome) => {
    switch (outcome._tag) {
      case "a":
      case "b":
        return;
      case "thrown": {
        // The payload narrows with the tag: `thrown` carries a message.
        const message: unknown = outcome.message;
        void message;
        return;
      }
      case "malformed_result":
      case "unknown_tool":
      case "malformed_args":
        return;
      case "timeout":
        return;
      case "retry_exhausted": {
        // The ladder's own arms narrow the same way: `retry_exhausted` carries
        // the attempt count and the last attempt's reason as fields (#117).
        const attempts: number = outcome.attempts;
        const last: string = outcome.last;
        void attempts;
        void last;
        return;
      }
      default:
        // Exhaustive: every arm above is handled, so nothing is left.
        return absurd(outcome);
    }
  },
});

defineAgent({
  model: async () => ({ content: "", toolCalls: [] }),
  tools: [flaky],
  instructions: "",
  onToolError: (outcome) => {
    switch (outcome._tag) {
      // @ts-expect-error `c` is not a tag this agent's tools can fail with
      case "c":
        return;
      default:
        return;
    }
  },
});

// The reason is still there beside the tag — the model's channel, unchanged.
defineAgent({
  model: async () => ({ content: "", toolCalls: [] }),
  tools: [flaky],
  instructions: "",
  onToolError: (outcome, ctx) => {
    const reason: string = outcome.reason;
    const kind: "error" = outcome.kind;
    const name: string = ctx.name;
    const callId: string = ctx.callId;
    void [reason, kind, name, callId];
  },
});
