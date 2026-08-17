// What the importer REFUSES, and what it is honestly lossy about.
//
// The golden test proves the importer agrees with fabrika on documents that
// compile. This file covers the other half: documents that must not compile,
// and the facts the import genuinely does not carry back.
import { describe, expect, it } from "vitest";
import { coder } from "./__fixtures__/templates";
import {
  chartFromWorkflow,
  chartFromWorkflowText,
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

  it("an event outside the operator's six — named, with the six listed", () => {
    const defects = defectsOf(
      mutate((doc) => {
        // biome-ignore lint/suspicious/noExplicitAny: untyped JSON document
        (region(doc) as any).states.queued.on["ISSUE.YOLO"] = "build";
      }),
    );
    expect(defects).toHaveLength(1);
    expect(defects[0]).toContain('"ISSUE.YOLO"');
    expect(defects[0]).toContain("DONE/PASS/FAIL/BLOCKED/WIP/UNBLOCKED");
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

  it("does not carry `actions` — an action name is inert data upstream too", () => {
    const json = JSON.stringify(lane);
    expect(json).not.toContain("incrementRetries");
  });
});
