import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import {
  type ToolCall,
  type ToolCmd,
  type ToolMsg,
  toolRouter,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { type Machine, Outcome } from "../../packages/tea/src/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import { cmdEdgeOver } from "../../packages/tea/src/pure/core.ts";

const schema = z.object({
  mode: z.literal("empty"),
  profile: z.enum(["promise", "effect"]).default("promise"),
  scenario: z.enum(["edge", "runtime"]).default("edge"),
});
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function tagged(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}
async function execute(input: z.infer<typeof schema>) {
  const router = toolRouter([]);
  const call: ToolCall = {
    callId: "empty-call",
    name: "read_invoice",
    args: { invoice: "INV-17" },
  };
  const command = router.toolOf(call);
  const defs = router.defs.map((d) => d.cmdType);
  const ctx = {
    ok: Outcome.ok,
    err: Outcome.err,
    emit: () => {
      throw new Error("unexpected emission");
    },
  };
  if (input.scenario === "edge") {
    const returned = await router.interpret.tool_rejected(command, ctx);
    const settled = cmdEdgeOver(router.defs, () => 17.25)(command, returned);
    assert.ok(tagged(settled));
    const outcome = router.outcomeOf(settled);
    assert.ok(outcome !== null);
    return {
      defs,
      command: wire(command),
      returned: wire(returned),
      settled: wire(settled),
      outcome: wire(outcome),
      parts: router.partsOf(call, outcome.outcome),
      resilience: router.resilienceOf(call),
    };
  }
  type Msg = ToolMsg<never>;
  type Cmd = ToolCmd<never>;
  type State = { messages: unknown[] };
  const apply = (
    state: State,
    message: Msg,
  ): readonly [State, readonly Cmd[]] => [
    {
      messages: [
        ...state.messages,
        wire({ message, outcome: router.outcomeOf(message) }),
      ],
    },
    [],
  ];
  const machine: Machine<State, Msg, Cmd, never, unknown> = {
    init: () => [{ messages: [] }, [router.toolOf(call)]],
    cmds: router.defs,
    update: { tool_rejected_ok: apply, tool_rejected_err: apply },
  };
  if (input.profile === "promise") {
    const live = await runPromise(machine, {
      interpret: router.interpret,
      terminal: (s) => s.messages.length === 1,
      clock: () => 17.25,
    }).ready;
    await live.done();
    const state = live.getState();
    await live.stop();
    return { defs, state };
  }
  const effectOf = <O, E>(work: () => Promise<Outcome<O, E>>) =>
    Effect.promise(work).pipe(
      Effect.flatMap((out) =>
        out._tag === "Ok" ? Effect.succeed(out.value) : Effect.fail(out.error),
      ),
    );
  const scope = await Effect.runPromise(Scope.make());
  const boot = await Effect.runPromise(
    Scope.provide(scope)(
      runEffect(machine, {
        terminal: (s) => s.messages.length === 1,
        clock: () => 17.25,
        interpret: {
          tool_rejected: (cmd) =>
            effectOf(async () => {
              const returned = await router.interpret.tool_rejected(cmd, ctx);
              assert.ok(returned !== undefined);
              return returned;
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
  return { defs, state };
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const frame = z
    .object({ id: z.string(), input: schema })
    .parse(JSON.parse(line));
  const view = await execute(frame.input);
  process.stdout.write(`${JSON.stringify({ id: frame.id, view })}\n`);
}
