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

import { Result } from "better-result";
import { z } from "zod";
import { absurd, Cmd, type PortEmitter, run, type Settled } from "../index";
import {
  type AgentTurn,
  createAgent,
  type Schema,
  type ToolCmd,
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
    input: z.object({ q: z.string() }),
    ok: z.object({ snippet: z.string() }),
    err: ["not_found", "rate_limited"],
    needs: Cmd.needs<KbCtx>(),
  },
  async ({ q }, ctx, fail) => {
    // The `R` slice lands on the handler's ctx: `ctx.kb` is typed.
    const snippet = ctx.kb.lookup(q);
    if (snippet === undefined) return fail({ _tag: "not_found" });
    // Detail rides beside the tag.
    if (q === "") return fail({ _tag: "rate_limited", afterMs: 250 });
    // A `Result.err` written `as const` is the same declared arm.
    if (q === " ") return Result.err({ _tag: "not_found" } as const);
    return Result.ok({ snippet });
  },
);

tool(
  "leaky",
  { input: z.object({}), ok: z.void(), err: ["not_found"] },
  // @ts-expect-error `timeout` is not a declared tag
  async (_args, _ctx, fail) => fail({ _tag: "timeout" }),
);

tool(
  "leaky_const",
  { input: z.object({}), ok: z.void(), err: ["not_found"] },
  // @ts-expect-error `timeout` is not a declared tag
  async () => Result.err({ _tag: "timeout" } as const),
);

tool(
  "wrong_ok",
  { input: z.object({}), ok: z.object({ n: z.number() }), err: [] },
  // @ts-expect-error the ok value must be what the `ok` schema parses
  async () => Result.ok({ n: "one" }),
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
  { input: z.object({ items: z.array(z.string()) }), ok: z.number(), err: [] },
  async ({ items }) => Result.ok(items.length),
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
