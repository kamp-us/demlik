import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import {
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

const frameSchema = z.object({
  id: z.string(),
  input: z.object({
    mode: z.enum(["edge", "runtime"]),
    scenario: z.enum(["identity", "error", "selected-ok", "selected-error"]),
    profile: z.enum(["promise", "effect"]).optional(),
  }),
});
type Input = z.infer<typeof frameSchema>["input"];
type Args = { invoice: string };
type ReadOk = { total: number; parser: string };
type Schema<T> = Parameters<typeof validateSync<T>>[0];
type Host = { marker: string };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function tagged(
  value: unknown,
): value is Record<string, unknown> & { type: string } {
  return record(value) && typeof value.type === "string";
}
function readOk(value: unknown): value is ReadOk {
  return (
    record(value) &&
    typeof value.total === "number" &&
    typeof value.parser === "string"
  );
}
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
async function execute(input: Input) {
  const trace: string[] = [];
  let inputCalls = 0;
  const args: Args = { invoice: "already-parsed" };
  const selected = input.scenario.startsWith("selected");
  const failed = input.scenario.endsWith("error");
  const owner = selected ? "B" : "A";
  const returned: ReadOk = { total: 20, parser: `raw-${owner}` };
  const failure: { _tag: "a_only" | "b_only"; detail: string } = {
    _tag: selected ? "b_only" : "a_only",
    detail: "original",
  };
  const inputSchema = (name: string): Schema<Args> => ({
    "~standard": {
      version: 1,
      vendor: "parsed-input-fixture",
      validate() {
        inputCalls += 1;
        trace.push(`input:${name}`);
        return {
          issues: [{ message: "raw input requires an invoice envelope" }],
        };
      },
    },
  });
  const outputSchema = (name: string): Schema<ReadOk> => ({
    "~standard": {
      version: 1,
      vendor: "parsed-input-fixture",
      validate(raw) {
        trace.push(`output:${name}`);
        if (!readOk(raw))
          return { issues: [{ message: "invoice total required" }] };
        return {
          value:
            input.scenario === "identity"
              ? raw
              : { total: raw.total + (name === "B" ? 100 : 1), parser: name },
        };
      },
    },
  });
  const inputA = inputSchema("A"),
    inputB = inputSchema("B");
  const outputA = outputSchema("A"),
    outputB = outputSchema("B");
  const make = (
    name: "A" | "B",
    inputSchema: Schema<Args>,
    output: Schema<ReadOk>,
  ) =>
    tool(
      "read_invoice",
      {
        description: name,
        input: inputSchema,
        ok: output,
        err: [`${name.toLowerCase()}_only`],
      },
      async (received, ctx: Host, { ok, fail }) => {
        trace.push(`handler:${name}:${received.invoice}:${ctx.marker}`);
        assert.equal(received, args);
        return failed ? fail(failure) : ok(returned);
      },
    );
  const a = make("A", inputA, outputA),
    b = make("B", inputB, outputB);
  const check = tool(
    "check_invoice",
    {
      description: "Check",
      input: inputSchema("check"),
      ok: outputSchema("check"),
      err: [],
    },
    async (_args, _ctx: Host, { ok }) => ok(returned),
  );
  const chosen = selected ? b : a;
  const router = toolRouter([chosen, check]);
  type Tools = typeof chosen | typeof check;
  type Command = ToolCmd<Tools>;
  type Msg = ToolMsg<Tools>;
  // A ToolDef consumes its already-parsed input, including on another same-name router.
  const command: Command = a({ callId: "direct-17", args });
  const ctx = {
    marker: "host",
    emit() {
      throw new Error("unexpected emission");
    },
    ok: Outcome.ok,
    err: Outcome.err,
  };
  const describe = (msg: unknown) => {
    assert.ok(tagged(msg) && record(msg.cmd));
    return {
      message: wire(msg),
      outcome: wire(router.outcomeOf(msg)),
      own: {
        argsSame: msg.cmd.args === args,
        resultSame: failed ? null : msg.value === returned,
        errorSame: failed ? msg.error === failure : null,
      },
    };
  };
  let rows: unknown[];
  let commandSame = false;
  if (input.mode === "edge") {
    const outcome = await chosen.interpret(command, ctx);
    const settled: unknown = cmdEdgeOver(router.defs, () => 17.25)(
      command,
      outcome,
    );
    assert.ok(record(settled) && typeof settled.type === "string");
    commandSame = settled.cmd === command;
    rows = [describe(settled)];
  } else {
    type State = { messages: unknown[] };
    const apply = (
      state: State,
      message: Msg,
    ): readonly [State, readonly Command[]] => {
      if (record(message)) commandSame = message.cmd === command;
      return [{ messages: [...state.messages, describe(message)] }, []];
    };
    const machine: Machine<State, Msg, Command, never, Host> = {
      init: () => [{ messages: [] }, [command]],
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
    if (input.profile === "promise") {
      const live = await runPromise(machine, {
        ctx,
        interpret: router.interpret,
        clock: () => 17.25,
        terminal: (s) => s.messages.length === 1,
      }).ready;
      await live.done();
      rows = live.getState().messages;
      await live.stop();
    } else {
      const lift = <O, E>(work: () => Promise<Outcome<O, E>>) =>
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
            ctx,
            terminal: (s) => s.messages.length === 1,
            clock: () => 17.25,
            interpret: {
              read_invoice: (cmd: CmdOf<typeof chosen>) =>
                lift(() => chosen.interpret(cmd, ctx)),
              check_invoice: (cmd: CmdOf<typeof check>) =>
                lift(() => check.interpret(cmd, ctx)),
              tool_rejected: (cmd) =>
                lift(async () => {
                  const out = await router.interpret.tool_rejected(cmd, ctx);
                  assert.ok(out !== undefined);
                  return out;
                }),
            },
          }),
        ),
      );
      const ready = await Effect.runPromiseExit(boot.ready);
      if (Exit.isFailure(ready)) throw Cause.squash(ready.cause);
      const done = await Effect.runPromiseExit(ready.value.done());
      if (Exit.isFailure(done)) throw Cause.squash(done.cause);
      rows = ready.value.getState().messages;
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }
  return {
    view: {
      command: wire(command),
      messages: rows,
      inputCalls,
      schemasSame:
        a.args === inputA &&
        b.args === inputB &&
        chosen.schema.ok === (selected ? outputB : outputA),
      trace,
    },
    sourceOnly: { commandObjectSame: commandSame },
  };
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const frame = frameSchema.parse(JSON.parse(line));
  process.stdout.write(
    `${JSON.stringify({ id: frame.id, ...(await execute(frame.input)) })}\n`,
  );
}
