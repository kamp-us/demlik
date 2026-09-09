import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Store } from "../index";
import { memoryStore } from "../mem";
import {
  type AgentMessage,
  type AgentTurn,
  type DefinedAgentEvent,
  type DefinedAgentState,
  defineAgent,
  status,
  tool,
} from "./index";

// ---------------------------------------------------------------------------
// #147 — the run seam takes an `AbortSignal`, and an abort is a TRANSITION.
//
// The properties under test are the ones a stop button needs and a throw cannot
// give: the run resolves rather than rejects, the outcome is durable so a resume
// reads a run that ended, an already-aborted signal costs zero model calls, and
// the work already in flight settles to its own end without reaching anyone.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = "You answer with one sentence, citing a search.";
const INPUT = "What is TEA?";

const ASK: AgentTurn = {
  content: "let me look",
  toolCalls: [{ callId: "c1", name: "search", args: { q: "tea" } }],
};
const ANSWER: AgentTurn = { content: "TEA folds the loop.", toolCalls: [] };

/** A tool nothing in the durable tests calls — it is here to give `T` a name. */
const search = tool(
  "search",
  {
    description: "Look a phrase up in the knowledge base.",
    input: z.object({ q: z.string() }),
    ok: z.object({ snippet: z.string() }),
    err: [],
  },
  async ({ q }, _ctx, { ok }) => ok({ snippet: `about ${q}` }),
);

/** The Model a defined agent over that tool runs — what its Store holds. */
type S = DefinedAgentState<typeof search>;

/** A tool whose handler parks until the test releases it, and records that it finished. */
function heldTool() {
  let release: () => void = () => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished: string[] = [];
  const held = tool(
    "search",
    {
      description: "Look a phrase up in the knowledge base.",
      input: z.object({ q: z.string() }),
      ok: z.object({ snippet: z.string() }),
      err: [],
    },
    async ({ q }, _ctx, { ok }) => {
      await parked;
      finished.push(q);
      return ok({ snippet: `about ${q}` });
    },
  );
  return { held, release: () => release(), finished };
}

/** A model that counts its calls and hands back the scripted turns in order. */
function counting(turns: readonly AgentTurn[]) {
  const calls: (readonly AgentMessage[])[] = [];
  let i = 0;
  const model = async (messages: readonly AgentMessage[]) => {
    calls.push(messages);
    const turn = turns[i] ?? ANSWER;
    i += 1;
    return turn;
  };
  return { model, calls };
}

describe("an already-aborted signal ends the run before the first model call", () => {
  it("resolves cancelled with a model-call counter of zero", async () => {
    const { model, calls } = counting([ASK, ANSWER]);
    const controller = new AbortController();
    controller.abort();

    const final = await defineAgent({
      model,
      tools: [],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { signal: controller.signal });

    expect(calls).toHaveLength(0);
    expect(final.run.phase).toBe("cancelled");
    expect(status(final).kind).toBe("cancelled");
    // Cancelled before `start`, so there was no identity to mint — and that is a
    // different fact from a live run that was stopped, kept as a different value.
    expect(final.run.phase === "cancelled" && final.run.runId).toBeNull();
  });

  it("makes the outcome durable, so the state a killed process left is terminal", async () => {
    const { model } = counting([ASK, ANSWER]);
    // Read the bytes at the `save` seam rather than through `load()`: a Store's
    // `load` returns `unknown` by design (storage does not know `S`), and what
    // is under test is what was WRITTEN.
    const live = memoryStore<S>();
    const saved: S[] = [];
    const store: Store<S> = {
      ...live,
      save: async (state) => {
        await live.save(state);
        saved.push(JSON.parse(JSON.stringify(state)) as S);
      },
    };
    const controller = new AbortController();
    controller.abort();

    await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { store, signal: controller.signal });

    const persisted = saved.at(-1);
    expect(persisted?.run.phase).toBe("cancelled");
    // Plain data: the cancelled phase survives a JSON round trip like the rest
    // of the slice, which is what makes it readable after a reload at all.
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted);
  });
});

describe("aborting mid-run settles the run rather than escaping it", () => {
  it("resolves on the cancelled Model — no rejection, no DriveFailedError", async () => {
    // The abort fires from INSIDE the first model call, so it lands while the
    // run is genuinely in flight rather than in a timing window a sleep guesses.
    const controller = new AbortController();
    const calls: number[] = [];
    const model = async () => {
      calls.push(1);
      controller.abort();
      return ASK;
    };

    const settled = await defineAgent({
      model,
      tools: [],
      instructions: INSTRUCTIONS,
    })
      .run(INPUT, { signal: controller.signal })
      .then(
        (state) => ({ ok: true as const, state }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    expect(settled.ok).toBe(true);
    if (!settled.ok) throw settled.error;
    expect(settled.state.run.phase).toBe("cancelled");
    expect(status(settled.state).kind).toBe("cancelled");
    // The one turn that WAS produced is not a run output: nothing finished.
    expect(settled.state.output).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("stops dispatch: the model is not asked for another turn after the abort", async () => {
    const controller = new AbortController();
    const { model, calls } = counting([ASK, ANSWER, ANSWER]);
    const abortingModel = async (messages: readonly AgentMessage[]) => {
      const turn = await model(messages);
      controller.abort();
      return turn;
    };

    const final = await defineAgent({
      model: abortingModel,
      tools: [],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { signal: controller.signal });

    expect(final.run.phase).toBe("cancelled");
    expect(calls).toHaveLength(1);
  });
});

describe("a resumed process reads a cancelled run as already ended", () => {
  it("does not restart it, and spends no model call doing so", async () => {
    const controller = new AbortController();
    const first = counting([ASK]);
    const abortingModel = async (messages: readonly AgentMessage[]) => {
      const turn = await first.model(messages);
      controller.abort();
      return turn;
    };

    // Process 1: copy the bytes out at the `save` seam — the one write a kill
    // can never take back — the moment the cancellation lands.
    const live = memoryStore<S>();
    let kill: (state: S) => void = () => {};
    const killedAt = new Promise<S>((resolve) => {
      kill = resolve;
    });
    const store: Store<S> = {
      ...live,
      save: async (state) => {
        await live.save(state);
        if (state.run.phase === "cancelled") {
          kill(JSON.parse(JSON.stringify(state)) as S);
        }
      },
    };
    await defineAgent({
      model: abortingModel,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { store, signal: controller.signal, runId: "run-1" });
    const killed = await killedAt;
    expect(killed.run.phase).toBe("cancelled");
    expect(killed.run.phase === "cancelled" && killed.run.runId).toBe("run-1");

    // Process 2: the same three lines over a Store holding those bytes, with a
    // FRESH signal that is never aborted. The run is over; nothing restarts it.
    const second = counting([ANSWER]);
    const resumed = await defineAgent({
      model: second.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, {
      store: memoryStore(killed),
      signal: new AbortController().signal,
      runId: "run-2",
    });

    expect(second.calls).toHaveLength(0);
    expect(resumed.run.phase).toBe("cancelled");
    expect(resumed.run.phase === "cancelled" && resumed.run.runId).toBe(
      "run-1",
    );
  });
});

describe("in-flight tool handlers after a cancellation", () => {
  it("settle to their own end, and their results reach no public channel", async () => {
    const { held, release, finished } = heldTool();
    const controller = new AbortController();
    const { model } = counting([ASK, ANSWER]);
    const events: DefinedAgentEvent<typeof held>[] = [];

    const running = defineAgent({
      model,
      tools: [held],
      instructions: INSTRUCTIONS,
    }).run(INPUT, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    // Let the first turn land and the tool go out, then stop the run with the
    // handler still parked.
    await vitestTick();
    controller.abort();
    // The handler is not recallable — a promise cannot be cancelled — so it runs
    // to its own end. Releasing it is what lets the runtime's teardown drain.
    release();
    const final = await running;

    expect(final.run.phase).toBe("cancelled");
    expect(finished).toEqual(["tea"]);
    // The turn that settled BEFORE the abort is public; the tool that settled
    // after it is not, and no `RunDone` is minted for a run nobody finished.
    expect(events.map((e) => e.type)).toEqual(["TurnSettled"]);
    // …and the late outcome never reached the Model either.
    expect(final.conversation?.toolRecords ?? []).toHaveLength(0);
  });
});

describe("an abort racing a finished run does not restate the outcome", () => {
  it("leaves a run that already reached done exactly as it ended", async () => {
    const controller = new AbortController();
    const { model } = counting([ANSWER]);

    const final = await defineAgent({
      model,
      tools: [],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { signal: controller.signal });
    controller.abort();

    expect(final.run.phase).toBe("done");
    expect(status(final).kind).toBe("done");
  });
});

/** Yield to the microtask queue long enough for a settled effect to fold. */
async function vitestTick(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
