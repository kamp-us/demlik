// What the importer REFUSES, and what it is honestly lossy about.
//
// The golden test proves the importer agrees with fabrika on documents that
// compile. This file covers the other half: documents that must not compile,
// and the facts the import genuinely does not carry back.
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_EVENTS_JSONL,
  CHECKOUT_ORIGINS,
  CHECKOUT_WORKFLOW,
} from "./__fixtures__/checkout";
import { coder } from "./__fixtures__/templates";
import { deriveLaneStatus, foldLane } from "./fold";
import { laneReport } from "./report";
import { laneFromFiles, reportInput } from "./sources";
import {
  chartFromWorkflow,
  chartFromWorkflowText,
  endPolarityOf,
  eventAlphabet,
  statesOf,
  WorkflowImportError,
} from "./workflow";

/** A deep clone of the coder template, for mutating into a bad document. */
const mutate = (edit: (doc: Record<string, never>) => void): unknown => {
  const doc = JSON.parse(JSON.stringify(coder));
  edit(doc);
  return doc;
};

const region = (doc: Record<string, never>): Record<string, never> =>
  // biome-ignore lint/suspicious/noExplicitAny: a test walking an untyped JSON document
  (doc as any).machine.states.pipeline.states.issue;

const defectsOf = (document: unknown): readonly string[] => {
  try {
    chartFromWorkflow(document);
  } catch (error) {
    if (error instanceof WorkflowImportError) return error.defects;
    throw error;
  }
  throw new Error("expected the import to refuse this document");
};

describe("chartFromWorkflow — what it refuses", () => {
  it("a document with no `machine.states` at all", () => {
    expect(defectsOf({})).toEqual([
      "document must carry a `machine.states` object",
    ]);
  });

  it("text that is not JSON", () => {
    expect(() => chartFromWorkflowText("{oops")).toThrow(WorkflowImportError);
  });

  it("a name that strips to nothing — a namespace with no event behind it", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (region(doc) as any).states.queued.on["ISSUE."] = "build";
      }),
    );
    expect(defects).toHaveLength(1);
    expect(defects[0]).toContain(
      "names no event once its namespace is stripped",
    );
  });

  it("one state spelling one event twice — a state routes each event once", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (region(doc) as any).states.queued.on.WIP = "blocked";
      }),
    );
    expect(defects).toHaveLength(1);
    expect(defects[0]).toContain("spells the same event twice");
  });

  it("a transition targeting a state that does not exist", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (region(doc) as any).states.queued.on["ISSUE.WIP"] = "biuld";
      }),
    );
    expect(defects).toEqual([
      'task "issue": "ISSUE.WIP" targets unknown state "biuld"',
    ]);
  });

  it("a guarded array that is not exactly two arms", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (region(doc) as any).states.review.on["ISSUE.FAIL"] = [
          { target: "build" },
        ];
      }),
    );
    expect(defects[0]).toContain("must be a two-arm array");
  });

  it("a machine-level state that is neither a phase nor a terminal", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (doc as any).machine.states.limbo = { on: {} };
      }),
    );
    expect(defects).toEqual([
      'machine-level state "limbo" is neither a `parallel` phase nor a `final` terminal',
    ]);
  });

  it("a final no phase's `onDone` pair targets", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (doc as any).machine.states.orphan = { type: "final" };
      }),
    );
    expect(defects).toEqual([
      'machine-level final "orphan" is targeted by no phase\'s `onDone` pair',
    ]);
  });

  it("EVERY defect at once — never the first one, never a half-import", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        const r = region(doc) as any;
        r.states.queued.on["ISSUE.WIP"] = "biuld";
        r.states.build.on["ISSUE.DONE"] = "reveiw";
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (doc as any).trigger = 7;
      }),
    );
    expect(defects).toHaveLength(3);
  });
});

describe("chartFromWorkflow — what it carries, and what it drops", () => {
  const lane = chartFromWorkflow(coder);
  const issue = lane.charts.issue;
  if (issue === undefined) throw new Error("missing");

  it("drops `hist` — it is an EDGE property in a chart, not a state", () => {
    expect([...statesOf(issue).keys()]).not.toContain("hist");
    expect(issue.states.pipeline?.blocked?.on?.UNBLOCKED).toEqual({
      resume: { fallback: "queued" },
    });
  });

  it("strips the event namespace — `ISSUE.WIP` and `WIP` are one event", () => {
    expect(Object.keys(issue.events).sort()).toEqual([
      "BLOCKED",
      "DONE",
      "FAIL",
      "PASS",
      "UNBLOCKED",
      "WIP",
    ]);
  });

  it("carries the guard NAME as a label, and never dereferences it", () => {
    expect(issue.states.pipeline?.review?.on?.FAIL).toEqual({
      target: "build",
      when: "retriesRemaining",
      otherwise: "frozen",
    });
  });

  it('LOSSY, on purpose: one phase group, and every event `scope: "edges"`', () => {
    // The authored twin (`__fixtures__/lane.ts`) splits these same states into
    // working/parked/done and scopes BLOCKED to `working`. The document records
    // neither, so the import does not invent them — it names the one group after
    // the workflow phase and leaves every event targeted.
    expect(Object.keys(issue.states)).toEqual(["pipeline"]);
    expect(new Set(Object.values(issue.events).map((e) => e.scope))).toEqual(
      new Set(["edges"]),
    );
  });

  it("labels an unlabelled guarded arm off the GRAMMAR, not off a name", () => {
    // No `guard` on the arm — so there is no name to carry, and the fallback
    // says what the two-arm array itself says rather than borrowing whatever
    // this consumer happens to call it.
    const bare = chartFromWorkflow(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (region(doc) as any).states.review.on["ISSUE.FAIL"][0] = {
          target: "build",
        };
      }),
    );
    expect(bare.charts.issue?.states.pipeline?.review?.on?.FAIL).toEqual({
      target: "build",
      when: "retries remain",
      otherwise: "frozen",
    });
  });

  it("does not carry `actions` — an action name is inert data upstream too", () => {
    const json = JSON.stringify(lane);
    expect(json).not.toContain("incrementRetries");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A COMPLETELY DIFFERENT VOCABULARY — the test this module exists to pass.
//
// `__fixtures__/checkout.ts` is the same GRAMMAR with none of the same NAMES:
// eight events, two namespaces, two phases, two task ids, nine state names, two
// terminals, a guard label and a history state, and not one of them is a name
// this package has ever seen. If any of the importer's rules were secretly
// about fabrika's vocabulary, this block is where it would show — and when
// phoenix #5800 lands a seventh event on the epic lane, this is the block that
// already said we import it.
// ═══════════════════════════════════════════════════════════════════════════
describe("a document with a completely different event vocabulary", () => {
  const lane = chartFromWorkflow(CHECKOUT_WORKFLOW, CHECKOUT_ORIGINS);
  const payment = lane.charts.payment;
  const parcel = lane.charts.parcel;
  if (payment === undefined || parcel === undefined) throw new Error("missing");

  it("shares NOT ONE event name with fabrika's — the premise, asserted", () => {
    const theirs = new Set(eventAlphabet(chartFromWorkflow(coder)));
    expect([...theirs].sort()).toEqual([
      "BLOCKED",
      "DONE",
      "FAIL",
      "PASS",
      "UNBLOCKED",
      "WIP",
    ]);
    expect(eventAlphabet(lane).filter((e) => theirs.has(e))).toEqual([]);
  });

  it("derives the alphabet off the document, namespaces stripped", () => {
    expect([...eventAlphabet(lane)].sort()).toEqual([
      "AUTHORISED",
      "DECLINED",
      "DISPATCHED",
      "HELD",
      "LOST",
      "PICKED",
      "RESUMED",
      "SUBMITTED",
    ]);
  });

  it("reads the phase chain, both terminals and the trigger", () => {
    expect(lane.phases).toEqual([
      { name: "authorisation", tasks: ["payment"] },
      { name: "fulfilment", tasks: ["parcel"] },
    ]);
    expect(lane.terminals).toEqual({
      complete: "settled",
      tripped: "cancelled",
    });
    expect(lane.trigger).toBe("cart.checkout-requested");
    expect(lane.id).toBe("checkout");
  });

  it("recognises all three edge forms by SHAPE, under foreign names", () => {
    const states = statesOf(payment);
    expect(states.get("awaiting-card")?.on?.SUBMITTED).toEqual({
      target: "authorising",
    });
    expect(states.get("authorising")?.on?.DECLINED).toEqual({
      target: "awaiting-card",
      when: "attemptsRemaining",
      otherwise: "abandoned",
    });
    // The history state is called `back` here. `hist` was fabrika's spelling of
    // it; `type: "history"` is the grammar, and that is what is read.
    expect(states.get("on-hold")?.on?.RESUMED).toEqual({
      resume: { fallback: "awaiting-card" },
    });
    expect([...states.keys()]).not.toContain("back");
  });

  it("keeps the terminal POLARITY off the guarded fallthrough", () => {
    const states = statesOf(payment);
    expect(endPolarityOf(states.get("captured"))).toBe(true);
    expect(endPolarityOf(states.get("abandoned"))).toBe("error");
    expect(endPolarityOf(statesOf(parcel).get("written-off"))).toBe("error");
    expect(endPolarityOf(states.get("authorising"))).toBe(false);
  });

  it("takes the retry budget and the extras off this document's `context`", () => {
    expect(lane.context.payment).toEqual({
      maxRetries: 3,
      extras: { attempts: 0, currency: "TRY" },
    });
  });

  it("folds a real run — the guard, the park and the resume all fire", () => {
    const source = laneFromFiles(
      JSON.stringify(CHECKOUT_WORKFLOW),
      CHECKOUT_EVENTS_JSONL,
      CHECKOUT_ORIGINS,
    );
    const states = foldLane(source.workflow, source.entries);
    // Declined once inside budget, parked, then RESUMED back to `authorising`
    // rather than to the region's initial — the resume, under a foreign name.
    expect(states.payment).toEqual({
      type: "captured",
      retries: 1,
      maxRetries: 3,
      was: "authorising",
    });
    expect(deriveLaneStatus(source.workflow, states).stateValue).toEqual({
      fulfilment: { parcel: "unpacked" },
    });
  });

  it("reports on it, in this consumer's own cast", () => {
    const source = laneFromFiles(
      JSON.stringify(CHECKOUT_WORKFLOW),
      CHECKOUT_EVENTS_JSONL,
      CHECKOUT_ORIGINS,
    );
    const { markdown } = laneReport(reportInput(source));
    expect(markdown).toContain("## checkout — active");
    expect(markdown).toContain("**fired by:** `cart.checkout-requested`");
    // The first phase finished; the second is the one drawn.
    expect(markdown).toContain("**authorisation:** complete");
    expect(markdown).toContain("### parcel — `unpacked`");
    expect(markdown).toContain("the warehouse's `PICKED`");
    expect(markdown).toContain("```mermaid");
    // and nothing of fabrika's leaked in through a default.
    for (const theirs of ["WIP", "UNBLOCKED", "the operator", "pipeline"]) {
      expect(markdown).not.toContain(theirs);
    }
  });
});
