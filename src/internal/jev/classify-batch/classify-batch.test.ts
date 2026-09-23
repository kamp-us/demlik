import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MsgType } from "../../../protocol";
import type { JevPort } from "../ask";
import {
  type Batch,
  type ClassifyBatchCmd,
  type ClassifyBatchErrMsg,
  type ClassifyBatchOkMsg,
  type ClassifyBatchState,
  createClassifyBatch,
  type ItemAnswer,
  type ItemQuestions,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures — an item whose key is its merchant, classified into two lines.
// ---------------------------------------------------------------------------

type Txn = { readonly merchant: string; readonly cents: number };
type Line = "groceries" | "dining";

const criteria = {
  groceries: "Supermarkets and grocers",
  dining: "Restaurants, cafés and bars",
} as const;

const knob = (over: Partial<Parameters<typeof make>[0]> = {}) => make(over);

function make(
  over: Partial<{
    maxItems: number;
    maxMs: number;
    concurrency: number;
    ttlMs: number;
    evictEveryMs: number;
    port: JevPort<ItemQuestions<Line>>;
  }> = {},
) {
  return createClassifyBatch<Txn, Line>({
    keyOf: (t) => t.merchant,
    criteria,
    maxItems: over.maxItems ?? 25,
    maxMs: over.maxMs ?? 2_000,
    concurrency: over.concurrency ?? 8,
    ttlMs: over.ttlMs ?? 60_000,
    ...(over.evictEveryMs === undefined
      ? {}
      : { evictEveryMs: over.evictEveryMs }),
    ...(over.port === undefined ? {} : { port: over.port }),
  });
}

const txns = (n: number, prefix = "m"): readonly Txn[] =>
  Array.from({ length: n }, (_, i) => ({
    merchant: `${prefix}${i}`,
    cents: 100 + i,
  }));

/** An answer for `key`, as the wire would carry it. */
const answerOf = (choice: Line, confidence = 0.9): ItemAnswer<Line> => ({
  type: "choice",
  choice,
  probabilities: { groceries: 1 - confidence, dining: confidence },
  confidence,
});

/** The OK settle Msg a Cmd would produce, answering every question it asked. */
function okFor(
  cmd: ClassifyBatchCmd<Line>,
  at: number,
  choice: Line = "dining",
): ClassifyBatchOkMsg<Line> {
  const request = cmd.input as { questions: ItemQuestions<Line> };
  const answers: Record<string, ItemAnswer<Line>> = {};
  for (const key of Object.keys(request.questions)) {
    answers[key] = answerOf(choice);
  }
  return {
    type: MsgType.ResilientOk,
    key: cmd.key,
    result: {
      answers,
      model: "jev-latest",
      usage: { input_tokens: 1, output_tokens: 1 },
      source: "port",
    },
    at,
  };
}

/** The err settle Msg for a Cmd. */
const errFor = (
  cmd: ClassifyBatchCmd<Line>,
  at: number,
): ClassifyBatchErrMsg => ({
  type: MsgType.ResilientErr,
  key: cmd.key,
  error: { _tag: "http_terminal", status: 401 },
  at,
});

/** Drive `add` over every item, gathering the Cmds each transition emitted. */
function addAll(
  k: ReturnType<typeof make>,
  state: ClassifyBatchState<Txn, Line>,
  items: readonly Txn[],
  at: number,
): readonly [ClassifyBatchState<Txn, Line>, readonly ClassifyBatchCmd<Line>[]] {
  let s = state;
  const cmds: ClassifyBatchCmd<Line>[] = [];
  for (const item of items) {
    const [next, emitted] = k.add(s, item, at);
    s = next;
    cmds.push(...emitted);
  }
  return [s, cmds];
}

/** The single element of a one-element array, or a failure naming the miss. */
function only<T>(xs: readonly T[]): T {
  const first = xs[0];
  if (first === undefined) throw new Error("expected a non-empty array");
  return first;
}

const questionsOf = (cmd: ClassifyBatchCmd<Line>): ItemQuestions<Line> =>
  (cmd.input as { questions: ItemQuestions<Line> }).questions;

const stateOf = (cmd: ClassifyBatchCmd<Line>): readonly Txn[] =>
  (cmd.input as { state: readonly Txn[] }).state;

// ---------------------------------------------------------------------------

describe("createClassifyBatch — the composition, not a reimplementation", () => {
  const source = readFileSync(join(__dirname, "index.ts"), "utf8");

  it("composes the four batteries and rolls none of them itself", () => {
    for (const composed of [
      "createBatchWindow",
      "createFanOut",
      "../../resilience/cache",
      "createJevAsk",
    ]) {
      expect(source).toContain(composed);
    }
  });

  it("holds no timer, no clock, no chunk loop and no cache map of its own", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toContain("setTimeout");
    expect(code).not.toContain("Date.now");
    // A `slice(`-based chunk loop is what `batch-window` already owns.
    expect(code).not.toContain("slice(");
    // The only cache is `../../resilience/cache`'s `TtlCache`.
    expect(code).not.toContain("new Map(");
  });
});

describe("cold cache — the native batch form, one choice per item", () => {
  it("turns 60 items at maxItems 25 into exactly 3 ask Cmds", () => {
    const k = knob();
    const items = txns(60);
    const [afterAdds, addCmds] = addAll(k, k.init(), items, 1_000);
    const [, windowCmds] = k.onWindow(afterAdds, 2_000);
    const cmds = [...addCmds, ...windowCmds];

    expect(cmds).toHaveLength(3);
    expect(cmds.map((c) => stateOf(c).length)).toEqual([25, 25, 10]);

    for (const cmd of cmds) {
      const batchItems = stateOf(cmd);
      const questions = questionsOf(cmd);
      // The item array IS the request `state` — no `{ transactions }` envelope.
      expect(batchItems.every((t) => typeof t.cents === "number")).toBe(true);
      expect(Object.keys(questions)).toEqual(batchItems.map((t) => t.merchant));
      for (const question of Object.values(questions)) {
        expect(question.type).toBe("choice");
        expect(question.criteria).toEqual(criteria);
      }
      // The instructions name the item's own key.
      expect(only(Object.values(questions)).instructions).toContain(
        only(batchItems).merchant,
      );
    }
  });

  it("gives the whole request state, not an envelope field", () => {
    const k = knob({ maxItems: 2 });
    const [, cmds] = addAll(k, k.init(), txns(2), 0);
    expect(cmds).toHaveLength(1);
    expect(stateOf(only(cmds))).toEqual(txns(2));
    expect(only(cmds).input).not.toHaveProperty("transactions");
  });
});

describe("warm cache — a cached key never enters a batch", () => {
  it("emits 0 Cmds on the second pass and answers every key", () => {
    const k = knob();
    const items = txns(60);
    const [afterAdds, addCmds] = addAll(k, k.init(), items, 1_000);
    const [afterWindow, windowCmds] = k.onWindow(afterAdds, 2_000);

    // Settle all three batches.
    let state = afterWindow;
    for (const cmd of [...addCmds, ...windowCmds]) {
      const [next] = k.onBatchOk(state, okFor(cmd, 3_000));
      state = next;
    }

    const [, secondPass] = addAll(k, state, items, 4_000);
    expect(secondPass).toEqual([]);

    for (const item of items) {
      expect(k.answerFor(state, item.merchant, 4_000)).toEqual({
        status: "answered",
        answer: answerOf("dining"),
      });
    }
  });

  it("re-batches a key once its TTL has run out", () => {
    const k = knob({ maxItems: 1, ttlMs: 10 });
    const [s1, cmds] = addAll(k, k.init(), txns(1), 0);
    const [s2] = k.onBatchOk(s1, okFor(only(cmds), 0));
    expect(k.answerFor(s2, "m0", 5).status).toBe("answered");
    expect(k.answerFor(s2, "m0", 10).status).toBe("absent");

    const [, again] = addAll(k, s2, txns(1), 10);
    expect(again).toHaveLength(1);
  });
});

describe("failure — marked in the slice, never written to the cache", () => {
  it("marks every key of a resilient_err batch failed and leaves the cache clean", () => {
    const k = knob({ maxItems: 3 });
    const items = txns(3);
    const [s1, cmds] = addAll(k, k.init(), items, 0);
    expect(cmds).toHaveLength(1);

    const [s2] = k.onBatchErr(s1, errFor(only(cmds), 500));

    for (const item of items) {
      expect(k.answerFor(s2, item.merchant, 500)).toEqual({
        status: "failed",
        error: { _tag: "http_terminal", status: 401 },
      });
    }
    expect(s2.cache.entries).toEqual({});

    // The key is re-addable — a failure is not an answer, so nothing blocks it.
    const [, retried] = addAll(k, s2, items, 600);
    expect(retried).toHaveLength(1);
  });

  it("clears a standing failure mark when the key is later answered", () => {
    const k = knob({ maxItems: 1 });
    const [s1, first] = addAll(k, k.init(), txns(1), 0);
    const [s2] = k.onBatchErr(s1, errFor(only(first), 10));
    expect(k.answerFor(s2, "m0", 10).status).toBe("failed");

    const [s3, second] = addAll(k, s2, txns(1), 20);
    const [s4] = k.onBatchOk(s3, okFor(only(second), 30));
    expect(k.answerFor(s4, "m0", 30)).toEqual({
      status: "answered",
      answer: answerOf("dining"),
    });
  });

  it("reports a re-added key as pending, not as the previous attempt's failure", () => {
    const k = knob({ maxItems: 2 });
    const items = txns(2);
    const [s1, first] = addAll(k, k.init(), items, 0);
    const [s2] = k.onBatchErr(s1, errFor(only(first), 10));
    expect(k.answerFor(s2, "m0", 10).status).toBe("failed");

    // Re-add ONE key of the failed batch: it is in flight again from here.
    const [s3, second] = k.add(s2, items[0] as Txn, 20);
    expect(second).toEqual([]);
    expect(k.answerFor(s3, "m0", 20)).toEqual({ status: "pending" });
    // Its batch-mate was not re-added, so its failure still stands.
    expect(k.answerFor(s3, "m1", 20).status).toBe("failed");

    // It stays pending for the whole of the new call — through the flush …
    const [s4, flushed] = k.onWindow(s3, 30);
    expect(flushed).toHaveLength(1);
    expect(k.answerFor(s4, "m0", 30)).toEqual({ status: "pending" });

    // … and only the new batch settling moves it off pending.
    const [s5] = k.onBatchOk(s4, okFor(only(flushed), 40));
    expect(k.answerFor(s5, "m0", 40)).toEqual({
      status: "answered",
      answer: answerOf("dining"),
    });
  });
});

describe("in-flight keys", () => {
  it("reports a buffered key as pending and never double-batches it", () => {
    const k = knob({ maxItems: 10 });
    const [s1, cmds] = addAll(k, k.init(), txns(3), 0);
    expect(cmds).toEqual([]);
    expect(k.answerFor(s1, "m1", 0)).toEqual({ status: "pending" });

    const [s2, again] = addAll(k, s1, txns(3), 1);
    expect(again).toEqual([]);
    expect(s2.window.buffer).toHaveLength(3);
  });

  it("bounds batches in flight by `concurrency` and backfills on settle", () => {
    const k = knob({ maxItems: 1, concurrency: 1 });
    const [s1, cmds] = addAll(k, k.init(), txns(3), 0);
    // Three batches flushed, one launched.
    expect(cmds).toHaveLength(1);
    expect(s1.fanOut.running).toHaveLength(1);
    expect(s1.fanOut.pending).toHaveLength(2);

    const [s2, backfill] = k.onBatchOk(s1, okFor(only(cmds), 1));
    expect(backfill).toHaveLength(1);
    expect(s2.fanOut.running).toHaveLength(1);
  });
});

describe("eviction is a Msg", () => {
  it("drops expired entries on `onEvict` and declares no Sub without a period", () => {
    const k = knob({ maxItems: 1, ttlMs: 10 });
    const [s1, cmds] = addAll(k, k.init(), txns(1), 0);
    const [s2] = k.onBatchOk(s1, okFor(only(cmds), 0));
    expect(Object.keys(s2.cache.entries)).toEqual(["m0"]);

    const [s3] = k.onEvict(s2, 10);
    expect(s3.cache.entries).toEqual({});
    // Window closed, no eviction period configured → no Subs at all.
    expect(k.subs(s3)).toEqual([]);
  });

  it("declares the window timer while a window is open", () => {
    const k = knob({ maxItems: 10, maxMs: 500 });
    const [s1] = addAll(k, k.init(), txns(1), 1_000);
    expect(k.subs(s1)).toEqual([
      { id: "jev-classify-batch", type: "deadline", atMs: 1_500 },
    ]);
  });

  it("mounts the window deadline, plus the eviction tick when a period is set", () => {
    const k = knob({ maxItems: 10, maxMs: 500, evictEveryMs: 60_000 });
    const [s1] = addAll(k, k.init(), txns(1), 1_000);
    const model = { classify: s1 };
    const entries = k.subEntries((m: typeof model) => m.classify);
    expect(entries.map((e) => [e.type, e.deps(model)])).toEqual([
      ["deadline", k.subs(s1)],
      ["cache", { name: "jev-classify-batch", intervalMs: 60_000 }],
    ]);
    expect(knob().subEntries((m: typeof model) => m.classify)).toHaveLength(1);
  });
});

describe("property — every key in exactly one batch", () => {
  it("holds over random item lists and maxItems in 1..50", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 80 }),
        fc.integer({ min: 1, max: 50 }),
        (merchants, maxItems) => {
          const items: readonly Txn[] = merchants.map((m, i) => ({
            merchant: m,
            cents: i,
          }));
          const k = make({ maxItems, concurrency: items.length + 1 });
          const [afterAdds, addCmds] = addAll(k, k.init(), items, 0);
          const [, windowCmds] = k.onWindow(afterAdds, 1);
          const cmds = [...addCmds, ...windowCmds];

          const unique = new Set(merchants);
          expect(cmds).toHaveLength(Math.ceil(unique.size / maxItems));

          const seen: string[] = [];
          for (const cmd of cmds) seen.push(...Object.keys(questionsOf(cmd)));
          expect(seen).toHaveLength(unique.size);
          expect(new Set(seen)).toEqual(unique);
        },
      ),
    );
  });
});

describe("the effect boundary is `../ask`'s", () => {
  it("parses a batch response into the per-key answers", async () => {
    const port: JevPort<ItemQuestions<Line>> = async (request) => ({
      status: 200,
      body: {
        model: "jev-1",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            answerOf("groceries"),
          ]),
        ),
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    });

    const k = make({ maxItems: 2, port });
    const [s1, cmds] = addAll(k, k.init(), txns(2), 0);
    const settle = await k.handlers().resilient_run(only(cmds));

    expect(settle.type).toBe(MsgType.ResilientOk);
    const [s2] = k.onBatchOk(s1, settle as ClassifyBatchOkMsg<Line>);
    expect(k.answerFor(s2, "m0", 0)).toEqual({
      status: "answered",
      answer: answerOf("groceries"),
    });
  });

  it("settles a 401 as the typed terminal error", async () => {
    const port: JevPort<ItemQuestions<Line>> = async () => ({
      status: 401,
      body: {},
    });
    const k = make({ maxItems: 1, port });
    const [s1, cmds] = addAll(k, k.init(), txns(1), 0);
    const settle = await k.handlers().resilient_run(only(cmds));

    expect(settle.type).toBe(MsgType.ResilientErr);
    const [s2] = k.onBatchErr(s1, settle as ClassifyBatchErrMsg);
    expect(k.answerFor(s2, "m0", 0)).toEqual({
      status: "failed",
      error: { _tag: "http_terminal", status: 401 },
    });
  });
});

describe("the slice is plain data", () => {
  it("survives a JSON round-trip with every verb still working", () => {
    const k = knob({ maxItems: 4 });
    const [s1, cmds] = addAll(k, k.init(), txns(4), 0);
    const [s2] = k.onBatchOk(s1, okFor(only(cmds), 10));

    const rehydrated: ClassifyBatchState<Txn, Line> = JSON.parse(
      JSON.stringify(s2),
    );
    expect(rehydrated).toEqual(s2);
    expect(k.answerFor(rehydrated, "m0", 10).status).toBe("answered");

    const batches: readonly Batch<Txn>[] = rehydrated.fanOut.done.map(
      (d) => d.item,
    );
    expect(only(batches).items).toEqual(txns(4));
  });
});
