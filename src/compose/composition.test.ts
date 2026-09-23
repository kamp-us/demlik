/**
 * The composition tier (#231).
 *
 * Every battery in this package is individually pure and individually tested,
 * and the one defect that escaped those suites (`bec6545`, criterion 7 of #214)
 * lived in none of them: it lived where three batteries are read together. This
 * file is the tier that targets that layer — the two helpers on their own, and
 * `classify-batch`'s composed read driven through its real verbs.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ClassifyBatchCmd,
  type ClassifyBatchErrMsg,
  type ClassifyBatchOkMsg,
  createClassifyBatch,
  type ItemAnswer,
  type ItemQuestions,
} from "../internal/jev/classify-batch";
import { MsgType } from "../protocol";
import { liftSlice, type ReadStep, readInOrder } from "./index";

// ---------------------------------------------------------------------------
// liftSlice — the record rebuild.
// ---------------------------------------------------------------------------

describe("liftSlice", () => {
  interface Host {
    readonly alpha: { readonly n: number };
    readonly beta: { readonly n: number };
    readonly gamma: readonly string[];
  }

  const host: Host = { alpha: { n: 1 }, beta: { n: 2 }, gamma: ["keep"] };

  it("round-trips a verb result through an arbitrary key, siblings untouched", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<keyof Host & ("alpha" | "beta")>("alpha", "beta"),
        fc.integer(),
        fc.array(fc.string()),
        (key, n, cmds) => {
          const [next, out] = liftSlice(key, host, [{ n }, cmds]);

          // The addressed key carries the verb's slice…
          expect(next[key]).toEqual({ n });
          // …every sibling is the SAME value it was, by identity…
          for (const other of ["alpha", "beta", "gamma"] as const) {
            if (other === key) continue;
            expect(next[other]).toBe(host[other]);
          }
          // …and the Cmds pass through untouched.
          expect(out).toBe(cmds);
        },
      ),
    );
  });

  it("returns a fresh record and mutates nothing", () => {
    const [next] = liftSlice("alpha", host, [{ n: 99 }, []]);
    expect(next).not.toBe(host);
    expect(host.alpha).toEqual({ n: 1 });
  });

  it("is the spread it replaces, exactly", () => {
    const [next, cmds] = liftSlice("beta", host, [{ n: 7 }, ["c"]]);
    expect(next).toEqual({ ...host, beta: { n: 7 } });
    expect(cmds).toEqual(["c"]);
  });
});

// ---------------------------------------------------------------------------
// readInOrder — precedence as data.
// ---------------------------------------------------------------------------

describe("readInOrder", () => {
  type Slices = { readonly cached?: string; readonly failed?: string };
  const cache: ReadStep<Slices, string> = {
    name: "cache",
    read: (s) => s.cached,
  };
  const failed: ReadStep<Slices, string> = {
    name: "failed",
    read: (s) => s.failed,
  };

  it("returns the first step that does not defer", () => {
    expect(readInOrder({ cached: "hit" }, [cache, failed], "absent")).toBe(
      "hit",
    );
    expect(readInOrder({ failed: "err" }, [cache, failed], "absent")).toBe(
      "err",
    );
  });

  it("returns `absent` when every step defers", () => {
    expect(readInOrder({}, [cache, failed], "absent")).toBe("absent");
    expect(readInOrder({}, [], "absent")).toBe("absent");
  });

  it("makes the precedence a value a test can reorder", () => {
    const both: Slices = { cached: "hit", failed: "err" };
    // This is the whole point: the order is an argument, so a reshuffle is
    // visible here rather than invisible inside a chain of `if` statements.
    expect(readInOrder(both, [cache, failed], "absent")).toBe("hit");
    expect(readInOrder(both, [failed, cache], "absent")).toBe("err");
  });
});

// ---------------------------------------------------------------------------
// The composed read itself — classify-batch over three battery slices.
// ---------------------------------------------------------------------------

type Txn = { readonly merchant: string; readonly cents: number };
type Line = "groceries" | "dining";

const criteria = {
  groceries: "Supermarkets and grocers",
  dining: "Restaurants, cafés and bars",
} as const;

/** One item per batch, so every `add` flushes and launches immediately. */
function knob() {
  return createClassifyBatch<Txn, Line>({
    keyOf: (t) => t.merchant,
    criteria,
    maxItems: 1,
    maxMs: 1_000,
    concurrency: 4,
    ttlMs: 60_000,
  });
}

const txn = (merchant: string): Txn => ({ merchant, cents: 100 });

const only = <T>(xs: readonly T[]): T => {
  const first = xs[0];
  if (first === undefined) throw new Error("expected a non-empty array");
  return first;
};

function okFor(
  cmd: ClassifyBatchCmd<Line>,
  at: number,
): ClassifyBatchOkMsg<Line> {
  const request = cmd.input as { questions: ItemQuestions<Line> };
  const answer: ItemAnswer<Line> = {
    type: "choice",
    choice: "dining",
    probabilities: { groceries: 0.1, dining: 0.9 },
    confidence: 0.9,
  };
  const answers: Record<string, ItemAnswer<Line>> = {};
  for (const key of Object.keys(request.questions)) answers[key] = answer;
  return {
    type: MsgType.ResilientOk,
    cmd,
    value: {
      answers,
      model: "jev-latest",
      usage: { input_tokens: 1, output_tokens: 1 },
      source: "port",
    },
    at,
  };
}

const errFor = (
  cmd: ClassifyBatchCmd<Line>,
  at: number,
): ClassifyBatchErrMsg => ({
  type: MsgType.ResilientErr,
  cmd,
  error: {
    _tag: "port_rejected",
    jev: { _tag: "http_terminal", status: 401 },
  },
  at,
});

describe("classify-batch's composed read (cache → failed → inFlight → absent)", () => {
  it("reports a re-added key as pending, never as the settled attempt's failure", () => {
    const k = knob();
    const [s0, cmds] = k.add(k.init(), txn("m0"), 0);
    const [s1] = k.onBatchErr(s0, errFor(only(cmds), 10));
    expect(k.answerFor(s1, "m0", 10)).toEqual({
      status: "failed",
      error: { _tag: "http_terminal", status: 401 },
    });

    // The host re-adds the key: a new attempt is now in flight, and the read
    // has to say so. This is the defect `bec6545` fixed — a polling host was
    // told to stop waiting for work that was running.
    const [s2] = k.add(s1, txn("m0"), 20);
    expect(k.answerFor(s2, "m0", 20)).toEqual({ status: "pending" });
  });

  it("puts the cache ahead of a standing failure", () => {
    const k = knob();
    const [s0, first] = k.add(k.init(), txn("m0"), 0);
    const [s1] = k.onBatchOk(s0, okFor(only(first), 10));
    expect(k.answerFor(s1, "m0", 10)).toMatchObject({ status: "answered" });

    // A standing failure mark on a key whose cached answer is still live: the
    // cache step is first in the order, so the answer wins.
    const alsoFailed = {
      ...s1,
      failed: { m0: { _tag: "http_terminal", status: 401 } } as const,
    };
    expect(k.answerFor(alsoFailed, "m0", 10)).toMatchObject({
      status: "answered",
    });
  });

  it("reports a key no slice has ever seen as absent", () => {
    const k = knob();
    expect(k.answerFor(k.init(), "nobody", 0)).toEqual({ status: "absent" });
  });

  it("reports an expired cache entry as absent, not as answered", () => {
    const k = knob();
    const [s0, cmds] = k.add(k.init(), txn("m0"), 0);
    const [s1] = k.onBatchOk(s0, okFor(only(cmds), 10));
    expect(k.answerFor(s1, "m0", 10)).toMatchObject({ status: "answered" });
    expect(k.answerFor(s1, "m0", 10 + 60_001)).toEqual({ status: "absent" });
  });
});
