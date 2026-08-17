// The fold, and the two claims the report leans its whole weight on: that it
// reproduces fabrika's fold, and that it is pure over a prefix.
import { describe, expect, it } from "vitest";
import {
  asJsonl,
  EPIC_DOCUMENT,
  EPIC_DOCUMENT_ABANDONED_CHILD,
  EPIC_LANE,
  EPIC_RUN_COMPLETE,
  EPIC_RUN_TRIPPED,
} from "./__fixtures__/epic";
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

// ── THE PHASE ADVANCE, against the driver's own ────────────────────────────
//
// This is the half neither committed template could test. `coder` and `chore`
// are single-phase, so `deriveLaneStatus`'s walk — the active phase, the
// `"waiting"` label on every phase below it, and the `noErrors` gate that trips
// on a COMPLETED phase — was reviewed and never run against a document that has
// a second phase to advance INTO.
//
// The document here is not one this repo drew. `__fixtures__/epic.ts` hands a
// `## Dependencies` block to fabrika's own vendored `lane emit`, and the runs
// through it are WALKED off the emitted grammar rather than typed out, so a
// re-vendored emitter with different states needs no edit here (phoenix #5800
// is rewriting exactly those states).
//
// The assertion is the same one the single-phase run gets and it is the whole
// point: at EVERY prefix, field for field, against fabrika's `deriveStatus`.
describe("deriveLaneStatus vs fabrika's, over a MULTI-PHASE epic run", () => {
  it("emits a document with more than one phase — else this suite proves nothing", () => {
    expect(EPIC_LANE.phases.length).toBeGreaterThan(1);
    expect(EPIC_LANE.terminals.complete).not.toBe(EPIC_LANE.terminals.tripped);
  });

  it.each([
    { name: "the run that completes", entries: EPIC_RUN_COMPLETE },
    { name: "the run that trips in a later phase", entries: EPIC_RUN_TRIPPED },
  ])("$name — matches at every prefix", ({ entries }) => {
    for (let k = 0; k <= entries.length; k++) {
      const prefix = entries.slice(0, k);
      expect(deriveLaneStatus(EPIC_LANE, foldLane(EPIC_LANE, prefix))).toEqual(
        oracleStatus(EPIC_DOCUMENT, asJsonl(prefix)),
      );
    }
  });

  it("actually advances — every phase is the active one at some prefix, in order", () => {
    const seen: string[] = [];
    for (let k = 0; k <= EPIC_RUN_COMPLETE.length; k++) {
      const { stateValue } = deriveLaneStatus(
        EPIC_LANE,
        foldLane(EPIC_LANE, EPIC_RUN_COMPLETE.slice(0, k)),
      );
      if (typeof stateValue === "string") continue;
      for (const [name, value] of Object.entries(stateValue)) {
        if (typeof value === "object" && seen.at(-1) !== name) seen.push(name);
      }
    }
    expect(seen).toEqual(EPIC_LANE.phases.map((p) => p.name));
  });

  it("labels the phases below the active one `waiting`, and none above it", () => {
    const midway = deriveLaneStatus(
      EPIC_LANE,
      foldLane(EPIC_LANE, EPIC_RUN_COMPLETE.slice(0, 11)),
    );
    const stateValue = midway.stateValue;
    if (typeof stateValue === "string")
      throw new Error("expected an active lane");
    const active = Object.entries(stateValue).find(
      ([, v]) => typeof v === "object",
    )?.[0];
    const order = EPIC_LANE.phases.map((p) => p.name);
    for (const [name, value] of Object.entries(stateValue)) {
      if (name === active) continue;
      expect(value).toBe("waiting");
      expect(order.indexOf(name)).toBeGreaterThan(order.indexOf(active ?? ""));
    }
  });

  it("trips on a completed phase, not on the phase the failure is in", () => {
    const status = deriveLaneStatus(
      EPIC_LANE,
      foldLane(EPIC_LANE, EPIC_RUN_TRIPPED),
    );
    expect(status).toEqual({
      ...oracleStatus(EPIC_DOCUMENT, asJsonl(EPIC_RUN_TRIPPED)),
    });
    expect(status.stateValue).toBe(EPIC_LANE.terminals.tripped);
    expect(status.context.errors).toHaveLength(1);
  });
});

// The one lane state no run of events can reach: `lane emit` boots a child that
// was closed WITHOUT landing straight into an error final, so the lane is
// tripped before its first event. It is also the case that makes the phase walk
// positional — the LATER phases' regions are sitting at their initials and the
// walk must still call them "not started" rather than reading them locally.
describe("a document that boots tripped", () => {
  const lane = chartFromWorkflow(EPIC_DOCUMENT_ABANDONED_CHILD);

  it("agrees with fabrika on an empty log", () => {
    expect(deriveLaneStatus(lane, foldLane(lane, []))).toEqual(
      oracleStatus(EPIC_DOCUMENT_ABANDONED_CHILD, ""),
    );
  });
});
