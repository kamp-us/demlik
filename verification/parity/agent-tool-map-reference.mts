import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import {
  type AgentTurn,
  agentTurnSchema,
  createAgent,
  type ToolCall,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  createFanOut,
  initFanOut,
} from "../../packages/tea/src/internal/flow/fan-out/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import type { Machine } from "../../packages/tea/src/pure/core.ts";

const input = z.object({
  id: z.string(),
  kind: z.enum(["fan", "agent", "runtime"]),
  profile: z.enum(["promise", "effect"]).optional(),
  config: z.object({
    failAt: z.number(),
    concurrency: z.number(),
    policy: z.boolean(),
  }),
  actions: z.array(
    z.object({
      op: z.string(),
      at: z.number().optional(),
      ids: z.array(z.string()).optional(),
      id: z.string().optional(),
      turn: z.unknown().optional(),
    }),
  ),
});
type Input = z.infer<typeof input>;
type Tool = { readonly type: "map_tool"; readonly call: ToolCall };
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));
const causeText =
  'tool: "map_fault" is reserved — it is an agent-owned Msg prefix';
async function execute(spec: Input) {
  const trace: unknown[] = [],
    cause = new Error(causeText);
  let count = 0,
    handlerWork = 0,
    saves = 0;
  const map = (id: string) => {
    trace.push(["toolOf", id]);
    count++;
    if (count === spec.config.failAt) throw cause;
  };
  const frames: unknown[] = [];
  const callOwners = new Map<string, ToolCall>();
  const rememberTurn = (value: unknown) => {
    const parsed = agentTurnSchema.parse(value);
    for (const call of parsed.toolCalls) callOwners.set(call.callId, call);
    return parsed;
  };
  const identities = (calls: readonly ToolCall[]) => ({
    checks: calls.length,
    originalSame:
      calls.length === 0
        ? null
        : calls.every((call) => callOwners.get(call.callId) === call),
  });
  const errorView = (caught: unknown) => {
    assert.equal(caught, cause);
    return {
      name: cause.name,
      message: cause.message,
      originalSame: caught === cause,
    };
  };
  if (spec.kind === "fan") {
    const fan = createFanOut<{ id: string }, { value: string }, Tool>({
      concurrency: spec.config.concurrency,
      idOf: (i) => i.id,
      of: (i) => {
        map(i.id);
        return {
          type: "map_tool",
          call: { callId: i.id, name: "invoice", args: {} },
        };
      },
    });
    let state = initFanOut<{ id: string }, { value: string }>();
    for (const a of spec.actions) {
      const before = state;
      let cmds: readonly unknown[] = [];
      let error: ReturnType<typeof errorView> | undefined;
      try {
        [state, cmds] =
          a.op === "scatter"
            ? fan.scatter(
                state,
                (a.ids ?? []).map((id) => ({ id })),
              )
            : fan.itemOk(state, a.id ?? "", { value: "checked" });
      } catch (e) {
        error = errorView(e);
      }
      frames.push(
        wire({
          op: a.op,
          state,
          commands: cmds,
          error: error ?? null,
          stateSame: state === before,
          trace: [...trace],
        }),
      );
    }
    return { frames, handlerWork, saves };
  }
  const agent = createAgent({
    stages: ["collect"],
    turnOf: (s) => s ?? "collect",
    payloadOf: (stage, conv) => ({ stage, turnCount: conv.turnCount }),
    schemas: { collect: agentTurnSchema },
    toolConcurrency: spec.config.concurrency,
    toolOf: (call): Tool => {
      map(call.callId);
      return { type: "map_tool", call };
    },
    toolResilienceOf: (call) => {
      trace.push(["policy", call.name, call.callId]);
      return spec.config.policy
        ? {
            retry: {
              baseMs: 5,
              factor: 1,
              capMs: 5,
              jitter: "none",
              maxAttempts: 3,
            },
          }
        : null;
    },
    rng: () => {
      trace.push(["rng", 0.25]);
      return 0.25;
    },
    model: () => ({
      withStructuredOutput: <T,>(schema: { parse: (v: unknown) => T }) => ({
        invoke: async () => schema.parse({ content: "empty", toolCalls: [] }),
      }),
    }),
  });
  let state = agent.init();
  const snapshot = (
    op: string,
    before: typeof state,
    cmds: readonly unknown[],
    error: unknown,
  ) =>
    frames.push(
      wire({
        op,
        state,
        commands: cmds,
        error: error ?? null,
        stateSame: state === before,
        trace: [...trace],
        subs: agent.subs(state),
        inputIdentity: identities([
          ...state.tools.pending,
          ...state.tools.running,
          ...state.tools.done.map((row) => row.item),
          ...state.tools.failed.map((row) => row.item),
        ]),
      }),
    );
  if (spec.kind === "runtime") {
    [state] = agent.start(state, "invoice-r", 10);
    const loaded = state;
    trace.length = 0;
    count = 0;
    type Msg = {
      readonly type: "mapping_turn";
      readonly turn: AgentTurn;
      readonly at: number;
    };
    const machine: Machine<typeof state, Msg, Tool, never, object> = {
      init: (s) => [s ?? loaded, []],
      update: {
        mapping_turn: (s, m) => {
          const [next, cmds] = agent.turn(s, m.turn, m.at);
          return [next, cmds.filter((c): c is Tool => c.type === "map_tool")];
        },
      },
      subs: [],
    };
    const store = {
      load: async () => loaded,
      migrate: (raw: unknown) => {
        assert.equal(raw, loaded);
        return loaded;
      },
      save: async () => {
        saves++;
      },
    };
    let transitionSaves = 0,
      stopSaves = 0;
    let reports = 0,
      reportedSame = true,
      rejected = false,
      liveState = loaded;
    const diagnostics: unknown[] = [];
    const onError = (e: unknown) => {
      reports++;
      reportedSame &&= e === cause;
      diagnostics.push(
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : String(e),
      );
    };
    const action = spec.actions[0];
    assert.ok(action);
    const turn = rememberTurn(action.turn);
    const msg: Msg = { type: "mapping_turn", turn, at: action.at ?? 0 };
    if (spec.profile === "promise") {
      const boot = runPromise(machine, {
        ctx: {},
        store,
        clock: () => 11,
        onError,
        interpret: {
          map_tool: async () => {
            handlerWork++;
            return undefined;
          },
        },
      });
      const live = await boot.ready;
      const before = saves;
      try {
        await live.dispatch(msg);
      } catch {
        rejected = true;
      }
      await live.idle();
      liveState = live.getState();
      transitionSaves = saves - before;
      await live.stop();
      stopSaves = saves - before - transitionSaves;
      saves -= before;
    } else {
      const scope = await Effect.runPromise(Scope.make());
      try {
        const boot = await Effect.runPromise(
          Scope.provide(scope)(
            runEffect(machine, {
              ctx: {},
              store,
              clock: () => 11,
              onError,
              interpret: {
                map_tool: () =>
                  Effect.sync(() => {
                    handlerWork++;
                    return undefined;
                  }),
              },
            }),
          ),
        );
        const live = await Effect.runPromise(boot.ready);
        const before = saves;
        const exit = await Effect.runPromiseExit(live.dispatch(msg));
        rejected = Exit.isFailure(exit);
        await Effect.runPromise(live.idle());
        liveState = live.getState();
        transitionSaves = saves - before;
        saves -= before;
      } finally {
        const beforeStop = saves;
        await Effect.runPromise(Scope.close(scope, Exit.void));
        stopSaves = saves - beforeStop;
      }
    }
    return wire({
      frames: [
        {
          op: "dispatch",
          state: liveState,
          commands: [],
          stateSame: liveState === loaded,
          trace: [...trace],
          error: { rejected, reports, reportedSame },
        },
      ],
      handlerWork,
      saves,
      transitionSaves,
      stopSaves,
      diagnostics,
    });
  }
  let started: ReturnType<typeof agent.start> | undefined;
  for (const a of spec.actions) {
    const before = state;
    let cmds: readonly unknown[] = [];
    let error: ReturnType<typeof errorView> | undefined;
    try {
      if (a.op === "start") {
        started = agent.start(state, "invoice-r", a.at ?? 0);
        [state, cmds] = started;
      } else if (a.op === "turn")
        [state, cmds] = agent.turn(state, rememberTurn(a.turn), a.at ?? 0);
      else if (a.op === "succeed") {
        assert.ok(started);
        const cmd = started[1].find((c) => c.type === "resilient_run");
        assert.ok(cmd);
        [state, cmds] = agent.succeed(
          state,
          agent.brain.ok(
            agent.brain({ key: cmd.key, input: cmd.input }),
            {
              key: cmd.key,
              purpose: "collect",
              output: rememberTurn(a.turn),
            },
            a.at ?? 0,
          ),
          a.at ?? 0,
        );
      } else if (a.op === "toolOk")
        [state, cmds] = agent.toolOk(
          state,
          a.id ?? "",
          { value: "checked" },
          a.at ?? 0,
        );
      else if (a.op === "toolErr")
        [state, cmds] = agent.toolErr(
          state,
          a.id ?? "",
          { kind: "error", reason: "business failure" },
          a.at ?? 0,
        );
      else if (a.op === "boot") [state, cmds] = agent.boot(state, a.at ?? 0);
      else if (a.op === "timer")
        [state, cmds] = agent.onTimer(state, {
          type: "deadline_exceeded",
          id: a.id ?? "",
          atMs: a.at ?? 0,
        });
      else throw new Error("fixture action");
    } catch (e) {
      error = errorView(e);
    }
    snapshot(a.op, before, cmds, error);
  }
  return { frames, handlerWork, saves };
}
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const spec = input.parse(JSON.parse(line));
    const output = await execute(spec);
    console.log(JSON.stringify({ id: spec.id, ok: true, output }));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      }),
    );
  }
}
