import assert from "node:assert/strict";
import {
  defineAgent,
  status,
  agentEvents,
  toolRouter,
  AGENT_EVENT_TYPES,
  type DefinedAgentState,
  type AgentMessage,
  type DefineAgentConfig,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { run, driveToDone } from "../../packages/tea/src/promise/index.ts";
import { DriveFailedError } from "../../packages/tea/src/runtime-types.ts";
interface Case {
  id?: string;
  maxTurns?: number;
  maxElapsedMs?: number;
  stop?: number;
  resume?: boolean;
  raw?: boolean;
}
const cases: Case[] = [
  { id: "unset" },
  { id: "zero", maxTurns: 0 },
  { id: "one", maxTurns: 1 },
  { id: "fraction", maxTurns: 1.5 },
  { id: "nan", maxTurns: NaN },
  { id: "elapsed-below", maxElapsedMs: 11 },
  { id: "elapsed-equal", maxElapsedMs: 10 },
  { id: "stop", stop: 2 },
  { id: "turn-before-stop", maxTurns: 1, stop: 1 },
  { id: "elapsed-before-stop", maxElapsedMs: 10, stop: 1 },
  { id: "raw", maxTurns: 1, raw: true },
  { id: "resume-stop", resume: true, stop: 1 },
  { id: "resume-elapsed", resume: true, maxElapsedMs: 20 },
  { id: "resume-turn", resume: true, maxTurns: 1 },
];
type S = DefinedAgentState<never>;
async function execute(c: Case, seed?: S) {
  let at = seed ? 100 : 50,
    calls = 0,
    predicates = 0;
  const prompts: unknown[] = [],
    events: unknown[] = [],
    saves: S[] = [],
    wires: string[] = [];
  const original = seed?.conversation?.turns ?? [];
  const turns = [0, 1, 2].map((i) => ({
    content: `round-${i}`,
    toolCalls:
      i === 2
        ? []
        : [0, 1, 2].map((j) => ({
            callId: `${i}-${j}`,
            name: "missing",
            args: { index: j },
          })),
    provider: { opaque: 17 },
    extra: { kept: true },
  }));
  const memory = memoryStore<S>(seed);
  const store = {
    ...memory,
    async save(s: S) {
      saves.push(s);
      wires.push(JSON.stringify(s));
      await memory.save(s);
    },
  };
  const model = async (messages: readonly AgentMessage[]) => {
    prompts.push(messages);
    const turn = turns[calls++];
    assert(turn, "no extra model call");
    at += 10;
    return turn;
  };
  const stop = c.stop;
  const config: DefineAgentConfig<never> = {
    model,
    tools: [],
    instructions: "Bound the conversation.",
    ...(c.maxTurns === undefined ? {} : { maxTurns: c.maxTurns }),
    ...(c.maxElapsedMs === undefined ? {} : { maxElapsedMs: c.maxElapsedMs }),
    ...(stop === undefined
      ? {}
      : {
          stopWhen: (s: S) => {
            predicates++;
            return (s.conversation?.turnCount ?? 0) >= stop;
          },
        }),
  };
  const agent = defineAgent<never>(config);
  let final: S,
    outcome = "resolved";
  try {
    if (c.raw) {
      const w = agent.machine("Do three rounds.");
      const h = run(w.machine, {
        ctx: {},
        store,
        clock: () => at,
        interpret: w.interpret,
        subscribe: w.subscribe,
        terminal: (s) =>
          status(s).kind === "cancelled" || status(s).kind === "done",
        events: agentEvents({ tools: toolRouter([]) }),
      });
      for (const type of AGENT_EVENT_TYPES) h.on(type, (e) => events.push(e));
      final = await driveToDone(
        h,
        { type: "agent_start", runId: "guard-run", at },
        (s) => status(s).kind === "cancelled" || status(s).kind === "done",
        { failed: (s) => status(s).kind === "failed" }
      );
    } else
      final = await agent.run("Do three rounds.", {
        ctx: {},
        store,
        clock: () => at,
        runId: "guard-run",
        onEvent: (e) => events.push(e),
      });
  } catch (error) {
    assert(error instanceof DriveFailedError);
    assert.equal(error.name, "DriveFailedError");
    assert(error.state);
    final = error.state;
    outcome = "failed";
  }
  assert(
    saves.every(
      (s) =>
        !s.conversation ||
        s.conversation.turns.every((t) =>
          [...original, ...turns].some((original) => original === t)
        )
    ),
    "canonical turns retain their owner"
  );
  assert.equal(
    final,
    saves.at(-1),
    "returned state is the saved canonical owner"
  );
  const phase = {
    prompts,
    events,
    saves: wires.map((w) => JSON.parse(w)),
    saveWires: wires,
    final,
    finalWire: JSON.stringify(final),
    calls,
    predicates,
    outcome,
  };
  return { phase, saves };
}
for (const c of cases) {
  let seed: S | undefined;
  if (c.resume) {
    const first = await execute({ maxTurns: 1 });
    seed = first.saves.find((s) => s.conversation?.awaiting.kind === "tools");
    assert(seed, "real saved awaiting-tools state");
  }
  const { phase } = await execute(c, seed);
  if (c.id === "unset" || c.id === "nan" || c.id === "fraction")
    assert.equal(phase.calls, c.id === "fraction" ? 2 : 3);
  if (c.resume) assert.equal(phase.calls, 0);
  if (c.id === "stop" || c.id === "resume-stop") {
    assert.equal(status(phase.final).kind, "cancelled");
    assert.equal(phase.outcome, "resolved");
    assert.equal(phase.final.failure, null);
  }
  if (c.id?.includes("before-stop")) assert.equal(phase.predicates, 0);
  console.log(JSON.stringify({ id: c.id, phase }));
}
