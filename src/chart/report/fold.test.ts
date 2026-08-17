// The fold, and the two claims the report leans its whole weight on: that it
// reproduces fabrika's fold, and that it is pure over a prefix.
import { describe, expect, it } from "vitest";
import {
  CODER_EVENTS_FROZEN_JSONL,
  CODER_EVENTS_JSONL,
} from "./__fixtures__/events";
import { coder, TEMPLATES } from "./__fixtures__/templates";
import {
  deriveStatus as fabrikaDeriveStatus,
  foldLog as fabrikaFoldLog,
  parseLog as fabrikaParseLog,
} from "./__fixtures__/vendor/fabrika-fold";
import { compile as fabrikaCompile } from "./__fixtures__/vendor/fabrika-machine";
import {
  deriveLaneStatus,
  foldLane,
  parseEventsJsonl,
  timeline,
  UnreplayableLogError,
} from "./fold";
import { chartFromWorkflow } from "./workflow";

/** fabrika's own compiled lane, for the same document. */
function oracle(document: unknown) {
  const compiled = fabrikaCompile(document);
  if (compiled._tag !== "Compiled")
    throw new Error(compiled.defects.join("; "));
  return compiled.lane;
}

function oracleStatus(document: unknown, jsonl: string) {
  const lane = oracle(document);
  const parsed = fabrikaParseLog(jsonl);
  if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
  const folded = fabrikaFoldLog(lane, parsed.entries);
  if (folded._tag !== "Folded") throw new Error(folded.defects.join("; "));
  return fabrikaDeriveStatus(lane, folded.states);
}

describe("foldLane", () => {
  const lane = chartFromWorkflow(coder);
  const entries = parseEventsJsonl(CODER_EVENTS_JSONL);

  it("walks the run the way the log says it went", () => {
    expect(foldLane(lane, entries)).toEqual({
      // the second FAIL spent the budget's last unit: `2/2`, still in review.
      issue: { type: "review", retries: 2, maxRetries: 2, was: "build" },
    });
  });

  it("resumes to where the task LEFT, not to the fallback", () => {
    // events 1..5 park the lane in `blocked` from `review`; event 6 unblocks.
    const parked = foldLane(lane, entries.slice(0, 5));
    expect(parked.issue?.type).toBe("blocked");
    expect(parked.issue?.was).toBe("review");
    expect(foldLane(lane, entries.slice(0, 6)).issue?.type).toBe("review");
  });

  it("falls through to the error final once the budget is spent", () => {
    const spent = foldLane(lane, parseEventsJsonl(CODER_EVENTS_FROZEN_JSONL));
    expect(spent.issue?.type).toBe("frozen");
    expect(deriveLaneStatus(lane, spent)).toMatchObject({
      stateValue: "tripped",
      status: "done",
    });
  });

  it("refuses a log the machine holds no cell for, rather than skipping it", () => {
    expect(() =>
      foldLane(lane, [
        { task: "issue", event: "ISSUE.PASS", at: "t0" },
        { task: "issue", event: "ISSUE.PASS", at: "t1" },
      ]),
    ).toThrow(UnreplayableLogError);
  });

  it("refuses a log naming a task this workflow does not have", () => {
    expect(() =>
      foldLane(lane, [{ task: "nope", event: "NOPE.WIP", at: "t0" }]),
    ).toThrow(UnreplayableLogError);
  });
});

// ── the claim `timeline` is built on ───────────────────────────────────────
//
// `timeline` walks once and carries the state forward, which is cheap. The
// DEFINITION of the state before step k is `foldLane(entries.slice(0, k))`,
// which is not cheap. They are the same thing because `foldLane` is a left
// fold — and that is asserted here rather than asserted in a comment.
describe("timeline is the prefix fold", () => {
  const lane = chartFromWorkflow(coder);
  const entries = parseEventsJsonl(CODER_EVENTS_JSONL);

  it("agrees with an explicit prefix fold at every single step", () => {
    const steps = timeline(lane, entries);
    expect(steps).toHaveLength(entries.length);
    for (const [k, step] of steps.entries()) {
      expect(step.from).toBe(foldLane(lane, entries.slice(0, k)).issue?.type);
      expect(step.to).toBe(foldLane(lane, entries.slice(0, k + 1)).issue?.type);
    }
  });

  it("recovers the `from → to` the log deliberately does not store", () => {
    expect(timeline(lane, entries).map((s) => `${s.from}→${s.to}`)).toEqual([
      "queued→build",
      "build→review",
      "review→build",
      "build→review",
      "review→blocked",
      "blocked→review",
      "review→build",
      "build→review",
    ]);
  });
});

// ── the derivation, against the driver's own ───────────────────────────────
describe.each(TEMPLATES)("$name — deriveLaneStatus vs fabrika's", ({
  document,
}) => {
  const lane = chartFromWorkflow(document);

  it("agrees on a fresh lane (no events yet)", () => {
    expect(deriveLaneStatus(lane, foldLane(lane, []))).toEqual(
      oracleStatus(document, ""),
    );
  });
});

describe("deriveLaneStatus vs fabrika's, over the whole coder run", () => {
  const lane = chartFromWorkflow(coder);
  const entries = parseEventsJsonl(CODER_EVENTS_JSONL);

  it.each([
    0, 1, 2, 3, 4, 5, 6, 7, 8,
  ])("matches field for field after %i event(s)", (k) => {
    const jsonl = entries
      .slice(0, k)
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(deriveLaneStatus(lane, foldLane(lane, entries.slice(0, k)))).toEqual(
      oracleStatus(coder, jsonl),
    );
  });

  it("matches on the tripped terminal too", () => {
    const frozen = parseEventsJsonl(CODER_EVENTS_FROZEN_JSONL);
    expect(deriveLaneStatus(lane, foldLane(lane, frozen))).toEqual(
      oracleStatus(coder, CODER_EVENTS_FROZEN_JSONL),
    );
  });
});
