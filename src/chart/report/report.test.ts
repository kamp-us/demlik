// The report, and — the part that actually matters — the CLI path, driven end
// to end by fabrika's own verbs' output.
import { describe, expect, it } from "vitest";
import {
  CODER_EVENTS_FROZEN_JSONL,
  CODER_EVENTS_JSONL,
} from "./__fixtures__/events";
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
  const source = laneFromFiles(CODER_JSON, CODER_EVENTS_JSONL);
  const { markdown } = laneReport(reportInput(source));

  it("says where it is, in the driver's own stateValue", () => {
    expect(markdown).toContain(
      "**where it is:** `pipeline` → `issue` = `review`",
    );
  });

  it("says what it is waiting on, in the driver's own vocabulary", () => {
    expect(markdown).toContain("**waiting on:** the `reviewer` shell");
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
    expect(markdown).toContain("class review current");
    // review --FAIL--> build was walked twice; queued --BLOCKED--> blocked never.
    expect(markdown).toContain(
      "review --> build : FAIL [retriesRemaining] »×2",
    );
    expect(markdown).toContain("queued --> blocked : BLOCKED\n");
    expect(markdown).toContain("blocked --> queued : UNBLOCKED (resume) »");
  });

  it("draws the two finals with different weight — the polarity, visible", () => {
    expect(markdown).toContain("class frozen tripped");
    expect(markdown).toContain("class shipped shipped");
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
  const source = laneFromCli(CODER_JSON, out.status, out.history);

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
      laneReport(reportInput(laneFromFiles(CODER_JSON, CODER_EVENTS_JSONL)))
        .markdown,
    );
  });

  it("carries the CLI's own verdict through on a tripped lane", () => {
    const tripped = fabrikaStdout(coder, CODER_EVENTS_FROZEN_JSONL);
    const { markdown } = laneReport(
      reportInput(laneFromCli(CODER_JSON, tripped.status, tripped.history)),
    );
    expect(markdown).toContain("`tripped` — the workflow is done.");
    expect(markdown).toContain(
      "**tripped:** `issue` — the lane lands on `tripped`",
    );
    // done: no active phase, so no diagram at all.
    expect(markdown).not.toContain("```mermaid");
  });
});

describe("waitingOn — fabrika's vocabulary, and its refusal to guess", () => {
  const coderLane = chartFromWorkflow(coder);
  const choreLane = chartFromWorkflow(chore);
  const issue = coderLane.charts.issue;
  const sweep = choreLane.charts.park_sweep;
  if (issue === undefined || sweep === undefined) throw new Error("missing");

  it("routes `queued` to the operator", () => {
    expect(waitingOn(issue, "queued")).toBe("the operator's `WIP`");
  });

  it.each([
    ["build", "builder"],
    ["review", "reviewer"],
    ["ship", "shipper"],
  ])("routes `%s` to the `%s` shell", (state, shell) => {
    expect(waitingOn(issue, state)).toBe(`the \`${shell}\` shell`);
  });

  it.each([
    "blocked",
    "human:cp-approval",
  ])("routes `%s` to a human", (state) => {
    expect(waitingOn(issue, state)).toBe("a human's `UNBLOCKED`");
  });

  it("waits on nothing at a final, of either polarity", () => {
    expect(waitingOn(issue, "shipped")).toBeNull();
    expect(waitingOn(issue, "frozen")).toBeNull();
  });

  it("REFUSES to invent a shell for a state nothing routes", () => {
    // `unpark` is a real chore state and it is not one of the three. fabrika's
    // `shellState()` answers `null` here rather than guessing; so does this,
    // and it says what the machine does say instead.
    const line = waitingOn(sweep, "unpark");
    expect(line).toContain("nothing routes `unpark`");
    expect(line).not.toContain("shell");
  });
});

describe("laneReport — a chore lane", () => {
  const { markdown } = laneReport(reportInput(laneFromFiles(CHORE_JSON, "")));

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
