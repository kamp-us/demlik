/**
 * The wrap-one-tool-cell recipe's compile-and-run gate (#543).
 *
 * `docs/how-to/wrap-one-tool-cell.md` wraps one tool's interpret cell with
 * `defineAgent(cfg).with({ interpret })`. The page's blocks are this file's
 * `#region` bodies (`page-mirrors.ts` holds the row), and the tests run them
 * against what the page says of each: the queue puts two runs' calls one after
 * the other, the timing wrapper reads `cmd.callId` and is entered first, and
 * above `toolConcurrency: 1` a wrapper's `next` returns before the handler has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AgentMessage,
  type AgentTurn,
  defineAgent,
  tool,
} from "../../agent";

/** What ran, in the order it ran. */
let log: string[] = [];

const fetchRate = tool(
  "fetch_rate",
  {
    description: "Fetch today's exchange rate from the upstream service",
    input: z.object({ pair: z.string() }),
    ok: z.object({ rate: z.number() }),
    err: [],
  },
  async ({ pair }, _ctx, { ok }) => {
    log.push(`start ${pair}`);
    await new Promise((r) => setTimeout(r, 5));
    log.push(`end ${pair}`);
    return ok({ rate: 1 });
  },
);

/** Asks for the rate of each pair the input names, then answers. */
async function model(messages: readonly AgentMessage[]): Promise<AgentTurn> {
  if (messages.some((m) => m.role === "tool"))
    return { content: "Done.", toolCalls: [] };
  const input = messages.find((m) => m.role === "user")?.content;
  const pairs = typeof input === "string" ? input.split(" ") : [];
  return {
    content: "Fetching.",
    toolCalls: pairs.map((pair) => ({
      callId: `call-${pair}`,
      name: "fetch_rate",
      args: { pair },
    })),
  };
}

const instructions = "You fetch rates.";

// #region in-turn
let tail: Promise<unknown> = Promise.resolve();
function inTurn<A>(job: () => Promise<A>): Promise<A> {
  const next = tail.then(job, job);
  tail = next.catch(() => undefined);
  return next;
}
// #endregion in-turn

// #region queued
const agent = defineAgent({ model, tools: [fetchRate], instructions });

const queued = agent.with({
  interpret: {
    fetch_rate: (next) => async (cmd, ctx, dispatch) =>
      inTurn(() => next(cmd, ctx, dispatch)),
  },
});
// #endregion queued

// #region traced
const traced = queued.with({
  interpret: {
    fetch_rate: (next) => async (cmd, ctx, dispatch) => {
      console.time(cmd.callId);
      try {
        return await next(cmd, ctx, dispatch);
      } finally {
        console.timeEnd(cmd.callId);
      }
    },
  },
});
// #endregion traced

/** `console.time` / `console.timeEnd` written into the log instead of stdout. */
function logTimers(): void {
  vi.spyOn(console, "time").mockImplementation((label) => {
    log.push(`time ${label}`);
  });
  vi.spyOn(console, "timeEnd").mockImplementation((label) => {
    log.push(`timeEnd ${label}`);
  });
}

describe("docs/how-to/wrap-one-tool-cell.md", () => {
  beforeEach(() => {
    log = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unwrapped, two runs' calls reach the handler together", async () => {
    await Promise.all([agent.run("usd_eur"), agent.run("usd_jpy")]);

    expect(log).toEqual([
      "start usd_eur",
      "start usd_jpy",
      "end usd_eur",
      "end usd_jpy",
    ]);
  });

  it("queued, they reach it one after the other and each run ends on its answer", async () => {
    const [eur, jpy] = await Promise.all([
      queued.run("usd_eur"),
      queued.run("usd_jpy"),
    ]);

    expect(log).toEqual([
      "start usd_eur",
      "end usd_eur",
      "start usd_jpy",
      "end usd_jpy",
    ]);
    expect(eur.output?.content).toBe("Done.");
    expect(jpy.output?.content).toBe("Done.");
  });

  it("the later wrapper is entered first, reads `cmd.callId`, and its `next` is the queued cell", async () => {
    logTimers();

    await Promise.all([traced.run("usd_eur"), traced.run("usd_jpy")]);

    expect(log).toEqual([
      "time call-usd_eur",
      "time call-usd_jpy",
      "start usd_eur",
      "end usd_eur",
      // The queue starts the next job before the first wrapper's `finally`.
      "start usd_jpy",
      "timeEnd call-usd_eur",
      "end usd_jpy",
      "timeEnd call-usd_jpy",
    ]);
  });

  it("inside one run a turn's calls already go out one at a time", async () => {
    await agent.run("usd_eur usd_jpy");

    expect(log).toEqual([
      "start usd_eur",
      "end usd_eur",
      "start usd_jpy",
      "end usd_jpy",
    ]);
  });

  it("above `toolConcurrency: 1`, `next` returns before the handler has", async () => {
    logTimers();
    const overlapping = defineAgent({
      model,
      tools: [fetchRate],
      instructions,
      toolConcurrency: 2,
    }).with({
      interpret: {
        fetch_rate: (next) => async (cmd, ctx, dispatch) => {
          console.time(cmd.callId);
          const returned = await next(cmd, ctx, dispatch);
          console.timeEnd(cmd.callId);
          return returned;
        },
      },
    });

    await overlapping.run("usd_eur");

    expect(log).toEqual([
      "time call-usd_eur",
      "start usd_eur",
      "timeEnd call-usd_eur",
      "end usd_eur",
    ]);
  });
});
