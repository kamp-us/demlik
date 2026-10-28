import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import {
  type ContentPart,
  type ToolCall,
  type ToolCmd,
  type ToolMsg,
  tool,
  toolRouter,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  type CmdOf,
  type Machine,
  Outcome,
} from "../../packages/tea/src/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import {
  cmdEdgeOver,
  type validateSync,
} from "../../packages/tea/src/pure/core.ts";

const inputSchema = z.object({
  mode: z.enum(["edge", "runtime"]),
  name: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  scenario: z.string().default("success"),
  profile: z.enum(["promise", "effect"]).default("promise"),
  declaration: z.enum(["duplicate", "reserved"]).optional(),
  resilience: z.boolean().default(false),
});
type Input = z.infer<typeof inputSchema>;
type ToolSchema<T> = Parameters<typeof validateSync<T>>[0];
type ReadArgs = { invoice: string };
type ReadOk = { total: number; currency: string };
type CheckArgs = { lines: number[]; expected: number };
type CheckOk = { valid: boolean; sum: number };
type Host = { bias: number };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function tagged(
  value: unknown,
): value is Record<string, unknown> & { type: string } {
  return record(value) && typeof value.type === "string";
}
function readArgs(value: unknown): value is ReadArgs {
  return record(value) && typeof value.invoice === "string";
}
function readOk(value: unknown): value is ReadOk {
  return (
    record(value) &&
    typeof value.total === "number" &&
    value.total >= 0 &&
    typeof value.currency === "string"
  );
}
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function details(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "thrown", message: String(error) };
}
function setup(input: Input) {
  const trace: unknown[] = [];
  const parts: readonly ContentPart[] = [
    { type: "text", text: "invoice media" },
  ];
  let parsed: unknown, returned: unknown, raised: unknown;
  const argsSchema: ToolSchema<ReadArgs> = {
    "~standard": {
      version: 1,
      vendor: "router-fixture",
      validate(raw) {
        trace.push(["input", "read"]);
        if (input.scenario === "async-input")
          return Promise.resolve({ value: { invoice: "async" } });
        if (!readArgs(raw))
          return {
            issues: [{ path: ["invoice"], message: "Expected invoice string" }],
          };
        const value =
          input.scenario === "identity"
            ? raw
            : { invoice: raw.invoice.trim().toUpperCase() };
        parsed = value;
        return { value };
      },
    },
  };
  const okSchema: ToolSchema<ReadOk> = {
    "~standard": {
      version: 1,
      vendor: "router-fixture",
      validate(raw) {
        trace.push(["output", "read"]);
        if (input.scenario === "async-output")
          return Promise.resolve({ value: { total: 0, currency: "USD" } });
        if (!readOk(raw))
          return {
            issues: [
              { path: ["total"], message: "Expected nonnegative total" },
            ],
          };
        return {
          value:
            input.scenario === "identity"
              ? raw
              : { total: raw.total, currency: raw.currency },
        };
      },
    },
  };
  const checkArgs: ToolSchema<CheckArgs> = {
    "~standard": {
      version: 1,
      vendor: "router-fixture",
      validate(raw) {
        trace.push(["input", "check"]);
        if (
          !record(raw) ||
          !Array.isArray(raw.lines) ||
          !raw.lines.every((n: unknown): n is number => typeof n === "number")
        )
          return {
            issues: [{ path: ["lines"], message: "Expected numeric lines" }],
          };
        const expected = typeof raw.expected === "number" ? raw.expected : 15;
        return { value: { lines: raw.lines, expected } };
      },
    },
  };
  const checkOk: ToolSchema<CheckOk> = {
    "~standard": {
      version: 1,
      vendor: "router-fixture",
      validate(raw) {
        trace.push(["output", "check"]);
        if (
          !record(raw) ||
          typeof raw.valid !== "boolean" ||
          typeof raw.sum !== "number"
        )
          return { issues: [{ message: "Expected check result" }] };
        return { value: { valid: raw.valid, sum: raw.sum } };
      },
    },
  };
  const read = tool(
    "read_invoice",
    {
      description: "Read the invoice total",
      input: argsSchema,
      ok: okSchema,
      err: ["unavailable"],
      ...(input.resilience
        ? {
            timeoutMs: 50,
            retry: {
              baseMs: 10,
              factor: 2,
              capMs: 100,
              jitter: "none",
              maxAttempts: 3,
            } as const,
          }
        : {}),
      content(value) {
        trace.push(["content", value.total]);
        if (input.scenario === "content-error")
          throw new Error("content failed");
        return parts;
      },
    },
    async (args, ctx: Host, { ok, fail }) => {
      trace.push(["handler", "read", args.invoice, ctx.bias, args === parsed]);
      if (
        input.scenario === "declared-return" ||
        input.scenario === "declared-raise"
      ) {
        const failure = {
          _tag: "unavailable",
          via: input.scenario,
          kind: "ok",
          reason: "payload",
        } as const;
        raised = failure;
        if (input.scenario === "declared-raise") throw failure;
        return fail(failure);
      }
      if (input.scenario === "error") throw new Error("invoice offline");
      if (input.scenario === "object") throw { message: "pretender" };
      if (input.scenario === "string") throw "invoice text";
      if (input.scenario === "null") throw null;
      if (input.scenario === "undefined") throw undefined;
      const value = {
        total: input.scenario === "negative-output" ? -1 : 15,
        currency: "USD",
        extra: "stripped",
      };
      returned = value;
      return ok(value);
    },
  );
  const check = tool(
    "check_invoice",
    {
      description: "Check invoice lines",
      input: checkArgs,
      ok: checkOk,
      err: [],
    },
    async (args, ctx: Host, { ok }) => {
      trace.push(["handler", "check", args.expected, ctx.bias]);
      const sum = args.lines.reduce((a, b) => a + b, 0);
      return ok({ valid: sum === args.expected, sum });
    },
  );
  const router = toolRouter([read, check]);
  return {
    read,
    check,
    router,
    trace,
    parts,
    identity: () => ({ parsed, returned, raised }),
    argsSchema,
    okSchema,
  };
}
async function execute(input: Input) {
  const { read, check, router, trace, parts, identity, argsSchema, okSchema } =
    setup(input);
  let phase = "declaration";
  const captured: Record<string, unknown> = {};
  try {
    if (input.declaration === "reserved") {
      assert.ok(input.name !== undefined);
      tool(
        input.name,
        { description: "reserved", input: argsSchema, ok: okSchema, err: [] },
        async (_args, _ctx, { ok }) => ok({ total: 0, currency: "USD" }),
      );
    }
    if (input.declaration === "duplicate") toolRouter([read, read]);
    const ctx = {
      bias: 1,
      emit: () => {
        throw new Error("unexpected emission");
      },
      ok: Outcome.ok,
      err: Outcome.err,
    };
    const call: ToolCall = {
      callId: "invoice-call",
      name: input.name ?? "read_invoice",
      args: input.args ?? { invoice: "inv-17" },
    };
    if (input.mode === "edge") {
      phase = "route";
      const command = router.toolOf(call);
      captured.command = wire(command);
      const edge = cmdEdgeOver(router.defs, () => 17.25);
      phase = "interpret";
      let returned:
        | Awaited<ReturnType<typeof read.interpret>>
        | Awaited<ReturnType<typeof check.interpret>>
        | Awaited<ReturnType<typeof router.interpret.tool_rejected>>;
      if (command.type === "read_invoice")
        returned = await read.interpret(command, ctx);
      else if (command.type === "check_invoice")
        returned = await check.interpret(command, ctx);
      else returned = await router.interpret.tool_rejected(command, ctx);
      captured.returned = wire(returned);
      phase = "settle";
      const settled = edge(command, returned);
      assert.ok(tagged(settled));
      captured.settled = wire(settled);
      const outcome = router.outcomeOf(settled);
      captured.outcome = wire(outcome);
      phase = "content";
      const maybeParts =
        outcome === null ? null : router.partsOf(call, outcome.outcome);
      const raw = identity();
      const own = {
        inputSchemaSame: read.args === argsSchema,
        argsSame:
          command.type === "read_invoice" ? command.args === call.args : null,
        returnedSame:
          settled.type === "read_invoice_ok"
            ? settled.value === raw.returned
            : null,
        failureSame:
          settled.type === "read_invoice_err" && raw.raised !== undefined
            ? settled.error === raw.raised
            : null,
        partsSame: maybeParts === null ? null : maybeParts === parts,
        elementSame: maybeParts === null ? null : maybeParts[0] === parts[0],
      };
      const foreign =
        input.scenario === "foreign-name"
          ? router.outcomeOf({ type: "foreign_ok" })
          : null;
      const forged =
        input.scenario === "forged-pure"
          ? router.outcomeOf(
              read.ok(
                read({ callId: "forged", args: { invoice: "x" } }),
                { total: 99, currency: "USD" },
                999,
              ),
            )
          : null;
      return {
        command: wire(command),
        returned: wire(returned),
        settled: wire(settled),
        outcome: wire(outcome),
        parts: wire(maybeParts),
        own,
        resilience: wire(router.resilienceOf(call)),
        foreign,
        forged,
        trace,
      };
    }
    phase = "runtime";
    const scenario = input.scenario;
    const calls: ToolCall[] =
      scenario === "workflow"
        ? [
            call,
            {
              callId: "check",
              name: "check_invoice",
              args: { lines: [4.5, 10.5], expected: 15 },
            },
            { callId: "unknown", name: "none", args: {} },
            { callId: "bad", name: "check_invoice", args: { lines: "bad" } },
          ]
        : [call];
    type Tools = typeof read | typeof check;
    type Msg = ToolMsg<Tools>;
    type Command = ToolCmd<Tools>;
    type State = { messages: unknown[] };
    const apply = (
      state: State,
      message: Msg,
    ): readonly [State, readonly Command[]] => [
      {
        messages: [
          ...state.messages,
          wire({ message, outcome: router.outcomeOf(message) }),
        ],
      },
      [],
    ];
    const machine: Machine<State, Msg, Command, never, Host> = {
      init: () => [{ messages: [] }, calls.map(router.toolOf)],
      cmds: router.defs,
      update: {
        read_invoice_ok: apply,
        read_invoice_err: apply,
        check_invoice_ok: apply,
        check_invoice_err: apply,
        tool_rejected_ok: apply,
        tool_rejected_err: apply,
      },
    };
    const model = scenario === "workflow" ? 4 : 1;
    if (input.profile === "promise") {
      const live = await runPromise(machine, {
        ctx: { bias: 1 },
        interpret: router.interpret,
        terminal: (s) => s.messages.length === model,
        clock: () => 17.25,
      }).ready;
      await live.done();
      const state = live.getState();
      await live.stop();
      return { state, trace };
    }
    const effectOf = <O, E>(
      work: () => Promise<
        import("../../packages/tea/src/index.ts").Outcome<O, E>
      >,
    ) =>
      Effect.promise(work).pipe(
        Effect.flatMap((out) =>
          out._tag === "Ok"
            ? Effect.succeed(out.value)
            : Effect.fail(out.error),
        ),
      );
    const scope = await Effect.runPromise(Scope.make());
    const boot = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          ctx: { bias: 1 },
          terminal: (s) => s.messages.length === model,
          clock: () => 17.25,
          interpret: {
            read_invoice: (cmd: CmdOf<typeof read>) =>
              effectOf(() => read.interpret(cmd, ctx)),
            check_invoice: (cmd: CmdOf<typeof check>) =>
              effectOf(() => check.interpret(cmd, ctx)),
            tool_rejected: (cmd) =>
              effectOf(async () => {
                const outcome = await router.interpret.tool_rejected(cmd, ctx);
                assert.ok(outcome !== undefined);
                return outcome;
              }),
          },
        }),
      ),
    );
    const ready = await Effect.runPromiseExit(boot.ready);
    if (Exit.isFailure(ready)) throw Cause.squash(ready.cause);
    const done = await Effect.runPromiseExit(ready.value.done());
    if (Exit.isFailure(done)) throw Cause.squash(done.cause);
    const state = ready.value.getState();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    return { state, trace };
  } catch (error) {
    return { error: details(error), phase, ...captured, trace };
  }
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  try {
    const frame = z
      .object({ id: z.string(), input: inputSchema })
      .parse(JSON.parse(line));
    let view:
      | Awaited<ReturnType<typeof execute>>
      | { error: ReturnType<typeof details> };
    try {
      view = await execute(frame.input);
    } catch (error) {
      view = { error: details(error) };
    }
    process.stdout.write(`${JSON.stringify({ id: frame.id, view })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id: null, error: details(error) })}\n`,
    );
  }
}
