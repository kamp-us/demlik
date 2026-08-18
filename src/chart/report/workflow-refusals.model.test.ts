// ═══════════════════════════════════════════════════════════════════════════
// THE IMPORTER'S REFUSALS — the net under the door with no type layer.
//
// `workflow.test.ts` pins what `chartFromWorkflow` DERIVES: the polarity, the
// `hist` → `resume` lowering, the guard labels, the terminals, the budget. This
// file pins what it REFUSES, which is a different obligation and the one that
// matters most here: this is the door a real consumer walks with bytes off
// disk, nothing has been compiled, and the runtime check is the only thing
// standing between a malformed document and a chart that is quietly wrong about
// the machine somebody is running.
//
// Each case below is a document that differs from a well-formed one in exactly
// one way, so a refusal that stops firing shows up as a passing import rather
// than as a differently-worded message.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import {
  chartFromWorkflow,
  eventAlphabet,
  WorkflowImportError,
} from "./workflow";

/** A two-state region: `queued --GO--> done`, `done` final. */
const region = () => ({
  initial: "queued",
  states: {
    queued: { on: { GO: "done" } },
    done: { type: "final" },
  },
});

/** One phase, one task, both terminals — the document every case below edits. */
const doc = (phase: unknown) => ({
  machine: {
    states: {
      phase1: phase,
      complete: { type: "final" },
      tripped: { type: "final" },
    },
  },
});

const phase = (regions: unknown) => ({
  type: "parallel",
  states: regions,
  onDone: [{ target: "complete" }, { target: "tripped" }],
});

const wellFormed = () => doc(phase({ issue: region() }));

/** The defects of a refusal, or a thrown assertion if it did not refuse. */
const defectsOf = (document: unknown): readonly string[] => {
  try {
    chartFromWorkflow(document);
  } catch (error) {
    if (error instanceof WorkflowImportError) return error.defects;
    throw error;
  }
  throw new Error("the document imported — expected a refusal");
};

describe("the document is well-formed, or it is refused", () => {
  it("imports the well-formed one, so every case below differs by one thing", () => {
    const lane = chartFromWorkflow(wellFormed());
    expect(lane.phases).toEqual([{ name: "phase1", tasks: ["issue"] }]);
    expect(eventAlphabet(lane)).toEqual(["GO"]);
  });

  it("refuses a region whose `initial` names no state of it", () => {
    const bad = region();
    expect(
      defectsOf(doc(phase({ issue: { ...bad, initial: "nowhere" } }))),
    ).toContain('task "issue": initial state "nowhere" is not in `states`');
  });

  it("refuses a PLAIN edge targeting a state that does not exist", () => {
    expect(
      defectsOf(
        doc(
          phase({
            issue: {
              initial: "queued",
              states: { queued: { on: { GO: "nope" } } },
            },
          }),
        ),
      ),
    ).toContain('task "issue": "GO" targets unknown state "nope"');
  });

  it("refuses a GUARDED ARM targeting a state that does not exist", () => {
    // Three lines from the plain-edge check and the one that was unguarded: a
    // two-arm array whose retry arm or whose fallthrough names nothing is a
    // document whose retry ladder leads off the machine.
    const defects = defectsOf(
      doc(
        phase({
          issue: {
            initial: "queued",
            states: {
              queued: {
                on: {
                  GO: [{ target: "nope", guard: "g" }, { target: "gone" }],
                },
              },
              done: { type: "final" },
            },
          },
        }),
      ),
    );
    expect(defects).toEqual([
      'task "issue": "GO" targets unknown state "nope"',
      'task "issue": "GO" targets unknown state "gone"',
    ]);
  });

  it("refuses a transition that is neither a target nor a guarded array", () => {
    expect(
      defectsOf(
        doc(
          phase({
            issue: {
              initial: "queued",
              states: {
                queued: { on: { GO: { target: "done" } } },
                done: { type: "final" },
              },
            },
          }),
        ),
      ),
    ).toContain('task "issue": "GO" is neither a target nor a guarded array');
  });

  it("refuses a state that is not an object", () => {
    expect(
      defectsOf(
        doc(
          phase({
            issue: {
              initial: "queued",
              states: { queued: 7, done: { type: "final" } },
            },
          }),
        ),
      ),
    ).toContain('task "issue": state "queued" is not an object');
  });

  it("refuses a state whose `on` is not an object", () => {
    expect(
      defectsOf(
        doc(
          phase({
            issue: {
              initial: "queued",
              states: { queued: { on: "GO" }, done: { type: "final" } },
            },
          }),
        ),
      ),
    ).toContain('task "issue": state "queued" carries a non-object `on`');
  });

  it("refuses a parallel phase carrying no task regions", () => {
    // An empty phase is not an empty answer — it completes on arrival, so the
    // lane advances past a phase that was supposed to hold the work.
    expect(defectsOf(doc(phase({})))).toContain(
      'phase "phase1": a parallel phase must carry task regions in `states`',
    );
  });

  it("refuses an `onDone` targeting a machine-level state that does not exist", () => {
    expect(
      defectsOf(
        doc({
          type: "parallel",
          states: { issue: region() },
          onDone: [{ target: "finished" }, { target: "tripped" }],
        }),
      ),
    ).toContain(
      'phase "phase1": `onDone` targets unknown machine-level state "finished"',
    );
  });

  it("refuses a machine that holds no `parallel` phase at all", () => {
    expect(
      defectsOf({ machine: { states: { complete: { type: "final" } } } }),
    ).toContain("machine holds no `parallel` phase state");
  });
});

// ── the `from` map, cross-checked against the document's own alphabet ───────
describe("strictFrom — a provenance key naming no event of THIS document", () => {
  it("is dropped silently by default, because a cast spans templates", () => {
    const lane = chartFromWorkflow(wellFormed(), {
      from: { GO: "cmd", UNBLOKED: { world: "a human" } },
    });
    expect(lane.charts.issue?.events.GO?.from).toBe("cmd");
    expect(eventAlphabet(lane)).toEqual(["GO"]);
  });

  it("is refused when the caller says the map was written for it", () => {
    expect(() =>
      chartFromWorkflow(wellFormed(), {
        from: { GO: "cmd", UNBLOKED: { world: "a human" } },
        strictFrom: true,
      }),
    ).toThrow(
      /`from` names "UNBLOKED", which no state in this document routes/,
    );
  });

  it("accepts a map that covers exactly the document's alphabet", () => {
    expect(() =>
      chartFromWorkflow(wellFormed(), {
        from: { GO: "cmd" },
        strictFrom: true,
      }),
    ).not.toThrow();
  });
});
