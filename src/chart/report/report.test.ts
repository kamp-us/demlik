// The report, and — the part that actually matters — the CLI path, driven end
// to end by fabrika's own verbs' output.
import { describe, expect, it } from "vitest";
import {
  EPIC_LANE,
  EPIC_RUN_COMPLETE,
  EPIC_RUN_TRIPPED,
  runEvents,
} from "./__fixtures__/epic";
import {
  CODER_EVENTS_FROZEN_JSONL,
  CODER_EVENTS_JSONL,
} from "./__fixtures__/events";
import { FABRIKA_ORIGINS } from "./__fixtures__/origins";
import { chore, coder } from "./__fixtures__/templates";
import {
  deriveStatus as fabrikaDeriveStatus,
  foldLog as fabrikaFoldLog,
  parseLog as fabrikaParseLog,
} from "./__fixtures__/vendor/fabrika-fold";
import { compile as fabrikaCompile } from "./__fixtures__/vendor/fabrika-machine";
import { laneReport, waitingOn } from "./report";
import { laneFromCli, laneFromFiles, reportInput } from "./sources";
import { chartFromWorkflow } from "./workflow";

const CODER_JSON = JSON.stringify(coder);
const CHORE_JSON = JSON.stringify(chore);

/**
 * WHAT `fabrika lane status` AND `fabrika lane history` ACTUALLY PRINT.
 *
 * Not a mock of them — their own producers. `status-verb.ts` is
 * `answer(JSON.stringify(deriveStatus(lane, foldLog(...)), null, 2))` and
 * `history-verb.ts` is `answer(JSON.stringify(entries, null, 2))`, so running
 * the vendored `fold.ts` and stringifying the same way reproduces the bytes a
 * shelled-out `fabrika` would put on stdout, character for character. The only
 * thing this stands in for is the process boundary.
 */
function fabrikaStdout(document: unknown, jsonl: string) {
  const compiled = fabrikaCompile(document);
  if (compiled._tag !== "Compiled")
    throw new Error(compiled.defects.join("; "));
  const parsed = fabrikaParseLog(jsonl);
  if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
  const folded = fabrikaFoldLog(compiled.lane, parsed.entries);
  if (folded._tag !== "Folded") throw new Error(folded.defects.join("; "));
  return {
    status: JSON.stringify(
      fabrikaDeriveStatus(compiled.lane, folded.states),
      null,
      2,
    ),
    history: JSON.stringify(parsed.entries, null, 2),
  };
}

describe("laneReport — the file path", () => {
  const source = laneFromFiles(CODER_JSON, CODER_EVENTS_JSONL, FABRIKA_ORIGINS);
  const { markdown } = laneReport(reportInput(source));

  it("says where it is, in the driver's own stateValue", () => {
    expect(markdown).toContain(
      "**where it is:** `pipeline` → `issue` = `review`",
    );
  });

  it("says what it is waiting on, derived from the events' origins", () => {
    expect(markdown).toContain(
      "**waiting on:** the work `review` dispatched — `PASS`, `FAIL` · the operator's `BLOCKED`",
    );
  });

  it("shows the spent retry budget and names the one-way door", () => {
    expect(markdown).toContain(
      "**retries:** 2/2 — spent; one `FAIL` from `frozen`",
    );
  });

  it("carries exactly one mermaid block — one per ACTIVE-phase task", () => {
    expect(markdown.match(/```mermaid/g)).toHaveLength(1);
  });

  it("lights the current node and marks the edges the log walked", () => {
    expect(markdown).toContain("class review teaActive");
    // review --FAIL--> build was walked twice; queued --BLOCKED--> blocked never.
    expect(markdown).toContain(
      "review --> build : FAIL [retriesRemaining] »×2",
    );
    expect(markdown).toContain("queued --> blocked : BLOCKED\n");
    expect(markdown).toContain("blocked --> queued : UNBLOCKED (resume) »");
  });

  it("draws the two finals with different weight — the polarity, visible", () => {
    expect(markdown).toContain("class frozen teaTripped");
    expect(markdown).toContain("class shipped teaShipped");
  });

  it("recomputes `from → to` per step in the timeline", () => {
    expect(markdown).toContain(
      "| 5 | 2026-08-16T14:31:09.043Z | `issue` | `ISSUE.BLOCKED` | `review` → `blocked` |",
    );
    expect(markdown).toContain(
      "| 6 | 2026-08-17T08:12:26.770Z | `issue` | `ISSUE.UNBLOCKED` | `blocked` → `review` |",
    );
  });
});

describe("laneReport — the CLI path", () => {
  const out = fabrikaStdout(coder, CODER_EVENTS_JSONL);
  const source = laneFromCli(
    CODER_JSON,
    out.status,
    out.history,
    FABRIKA_ORIGINS,
  );

  it("parses both verbs' stdout without a single phoenix change", () => {
    expect(source.entries).toHaveLength(8);
    expect(source.status).toEqual({
      stateValue: { pipeline: { issue: "review" } },
      status: "active",
      context: { issue: { retries: 2, maxRetries: 2 }, errors: [] },
    });
  });

  it("produces byte-identical markdown to the file path", () => {
    // The two paths differ ONLY in where the status came from. If they can
    // diverge, the derived one is wrong — which is the whole assertion.
    expect(laneReport(reportInput(source)).markdown).toBe(
      laneReport(
        reportInput(
          laneFromFiles(CODER_JSON, CODER_EVENTS_JSONL, FABRIKA_ORIGINS),
        ),
      ).markdown,
    );
  });

  it("carries the CLI's own verdict through on a tripped lane", () => {
    const tripped = fabrikaStdout(coder, CODER_EVENTS_FROZEN_JSONL);
    const { markdown } = laneReport(
      reportInput(
        laneFromCli(
          CODER_JSON,
          tripped.status,
          tripped.history,
          FABRIKA_ORIGINS,
        ),
      ),
    );
    expect(markdown).toContain("`tripped` — the workflow is done.");
    expect(markdown).toContain(
      "**tripped:** `issue` — the lane lands on `tripped`",
    );
    // done: no active phase, so no diagram at all.
    expect(markdown).not.toContain("```mermaid");
  });
});

// ── WAITING ON, DERIVED ────────────────────────────────────────────────────
//
// Every sentence below comes out of the events the state routes and the `from`
// each of those events declares. `report.ts` holds no state name, no event name
// and no job title; the cast is fabrika's, stated once at the import boundary
// (`__fixtures__/origins.ts`) and read from the chart thereafter.
describe("waitingOn — derived from the events' declared origin", () => {
  const coderLane = chartFromWorkflow(coder, FABRIKA_ORIGINS);
  const choreLane = chartFromWorkflow(chore, FABRIKA_ORIGINS);
  const issue = coderLane.charts.issue;
  const sweep = choreLane.charts.park_sweep;
  if (issue === undefined || sweep === undefined) throw new Error("missing");

  it("names the operator, in the words the caller declared", () => {
    // `queued` routes WIP and BLOCKED and both are the operator's, so both are
    // named. The old hard-coded answer said `WIP` alone and was WRONG about
    // this state: a reader who acts on it does not know a BLOCKED is accepted
    // here too.
    expect(waitingOn(issue, "queued")).toBe("the operator's `WIP`, `BLOCKED`");
  });

  it.each([
    "build",
    "review",
    "ship",
  ])("names the work `%s` dispatched, plus whoever else can speak", (state) => {
    const line = waitingOn(issue, state);
    expect(line).toContain(`the work \`${state}\` dispatched`);
    // BLOCKED is live in every working state and it is NOT the dispatched
    // work's to send, so it appears as its own group rather than being
    // folded into one.
    expect(line).toContain("the operator's `BLOCKED`");
  });

  it("says exactly what the shell reports back, per state", () => {
    expect(waitingOn(issue, "review")).toBe(
      "the work `review` dispatched — `PASS`, `FAIL` · the operator's `BLOCKED`",
    );
    expect(waitingOn(issue, "ship")).toBe(
      "the work `ship` dispatched — `DONE` · the operator's `BLOCKED`",
    );
  });

  it.each([
    "blocked",
    "human:cp-approval",
  ])("routes `%s` to a human — verbatim, article and all", (state) => {
    expect(waitingOn(issue, state)).toBe("a human's `UNBLOCKED`");
  });

  it("waits on nothing at a final, of either polarity", () => {
    expect(waitingOn(issue, "shipped")).toBeNull();
    expect(waitingOn(issue, "frozen")).toBeNull();
  });

  it("answers a state the old list had never heard of — no special case", () => {
    // `unpark` is a chore state and was not one of the three shell states, so
    // the old code refused it. There is nothing to refuse now: it routes four
    // events, they declare their origins, and the answer falls out.
    expect(waitingOn(sweep, "unpark")).toBe(
      "the work `unpark` dispatched — `DONE`, `FAIL` · the operator's `WIP`, `BLOCKED`",
    );
  });
});

// ── AND ITS REFUSAL TO GUESS ───────────────────────────────────────────────
describe("waitingOn — with no provenance to read", () => {
  // The SAME documents, imported without the map: `workflow.json` carries no
  // provenance of its own, so this is what an importer that is handed nothing
  // must produce.
  const issue = chartFromWorkflow(coder).charts.issue;
  if (issue === undefined) throw new Error("missing");

  it("says which events the state accepts, and nothing about who sends them", () => {
    expect(waitingOn(issue, "build")).toBe("`build` accepts `DONE`, `BLOCKED`");
  });

  it("invents no sender anywhere in the report", () => {
    const { markdown } = laneReport(
      reportInput(laneFromFiles(CODER_JSON, CODER_EVENTS_JSONL)),
    );
    expect(markdown).toContain("**waiting on:** `review` accepts");
    expect(markdown).not.toContain("operator");
    expect(markdown).not.toContain("shell");
  });

  it("does not round a PARTIAL map up to a whole one", () => {
    const partial = chartFromWorkflow(coder, {
      from: { DONE: "cmd", PASS: "cmd", FAIL: "cmd" },
    });
    const chart = partial.charts.issue;
    if (chart === undefined) throw new Error("missing");
    expect(waitingOn(chart, "build")).toBe(
      "the work `build` dispatched — `DONE` · `BLOCKED`, from somewhere the chart does not say",
    );
  });

  it("says so plainly at a live state that routes nothing", () => {
    const deadEnd = {
      events: {},
      states: { p: { stalled: { initial: true as const } } },
    };
    expect(waitingOn(deadEnd, "stalled")).toBe(
      "`stalled` accepts no events, and it is not a final",
    );
  });
});

describe("laneReport — a chore lane", () => {
  const { markdown } = laneReport(
    reportInput(laneFromFiles(CHORE_JSON, "", FABRIKA_ORIGINS)),
  );

  it("names the trigger the document declares", () => {
    expect(markdown).toContain("**fired by:** `lane-parked`");
  });

  it("says the log is empty rather than printing an empty table", () => {
    expect(markdown).toContain("_no events yet");
  });

  it("titles itself from the document's own id", () => {
    expect(markdown.startsWith("## park-sweep — active")).toBe(true);
  });
});

// ── A MULTI-PHASE LANE, DRAWN ──────────────────────────────────────────────
//
// The editorial call the module opened with, extended to the phase dimension:
// diagrams for the ACTIVE phase's tasks, one line for every phase that is
// already finished or has not started. The lane is fabrika's own emitted epic
// (`__fixtures__/epic.ts`), so nothing below may name one of its states.
describe("laneReport — more than one phase", () => {
  const phaseNames = EPIC_LANE.phases.map((p) => p.name);
  const midway = laneReport({
    workflow: EPIC_LANE,
    entries: EPIC_RUN_COMPLETE.slice(0, 12),
  }).markdown;

  it("draws ONLY the active phase's tasks", () => {
    const active = EPIC_LANE.phases[1];
    if (active === undefined) throw new Error("expected a second phase");
    const fences = midway.split("```mermaid").length - 1;
    expect(fences).toBe(active.tasks.length);
    for (const taskId of active.tasks) {
      expect(midway).toContain(`### ${taskId} —`);
    }
    for (const taskId of EPIC_LANE.phases[0]?.tasks ?? []) {
      expect(midway).not.toContain(`### ${taskId} —`);
    }
  });

  it("gives a finished phase one line — with WHICH ending each task reached", () => {
    expect(midway).toContain(`**${phaseNames[0]}:** complete — 2 tasks:`);
    for (const taskId of EPIC_LANE.phases[0]?.tasks ?? []) {
      expect(midway).toMatch(new RegExp(`\`${taskId}\` = \`[a-z_:]+\``));
    }
  });

  it("gives a phase that has not started one line, and no leaves", () => {
    expect(midway).toContain(
      `**${phaseNames[2]}:** waiting — 1 task, not started.`,
    );
    for (const taskId of EPIC_LANE.phases[2]?.tasks ?? []) {
      expect(midway).not.toContain(`\`${taskId}\` = \``);
    }
  });

  it("keeps the phases in their declared order — finished, active, not started", () => {
    // Anchored on each phase's own BLOCK, not on its name: the name also occurs
    // in the title and in the `where it is` line, and a bare `indexOf` reads
    // those instead.
    const positions = [
      midway.indexOf(`**${phaseNames[0]}:**`),
      midway.indexOf("### "),
      midway.indexOf(`**${phaseNames[2]}:**`),
    ];
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("marks a tripped phase as tripped, and marks WHICH of its tasks tripped", () => {
    const report = laneReport({
      workflow: EPIC_LANE,
      entries: EPIC_RUN_TRIPPED,
    }).markdown;
    const tripped = EPIC_LANE.phases[1];
    if (tripped === undefined) throw new Error("expected a second phase");
    expect(report).toContain(`**${tripped.name}:** tripped —`);
    expect(report).toContain("**(tripped)**");
    // The phases below it never ran — `stateValue` collapsed to the terminal
    // name and cannot say so, which is why the standings are derived instead.
    expect(report).toContain(`**${phaseNames[2]}:** waiting —`);
    expect(report).toContain(
      `the lane lands on \`${EPIC_LANE.terminals.tripped}\``,
    );
  });

  it("marks a tripped region distinctly from a finished one, in the ACTIVE phase", () => {
    // One region of the first phase freezes while its sibling is still moving,
    // so the phase is still active and both are drawn — the case where the
    // `end: "error"` polarity is worth having and `end: true` would not do.
    const first = EPIC_LANE.phases[0]?.tasks[0];
    if (first === undefined) throw new Error("expected a first task");
    const entries = runEvents(EPIC_LANE, { outcomes: { [first]: "error" } });
    const report = laneReport({
      workflow: EPIC_LANE,
      entries: entries.slice(0, 7),
    }).markdown;
    expect(report).toContain(`### ${first} —`);
    expect(report).toContain("— TRIPPED");
    expect(report).toContain("landed on the error final");
    expect(report).toContain(
      `\`${phaseNames[0]}\` will trip the lane when its siblings finish`,
    );
  });

  it("still shows the phase breakdown once the lane is done", () => {
    const done = laneReport({
      workflow: EPIC_LANE,
      entries: EPIC_RUN_COMPLETE,
    }).markdown;
    expect(done).toContain("— done");
    expect(done).not.toContain("```mermaid");
    for (const name of phaseNames) {
      expect(done).toContain(`**${name}:** complete —`);
    }
  });
});
