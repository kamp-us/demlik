// ═══════════════════════════════════════════════════════════════════════════
// THE PROCESS BOUNDARY, CROSSED.
//
// Every other test in this module runs fabrika's VENDORED source over event
// logs we composed ourselves. That is a real oracle and it is still ONE
// process: until this file existed, nobody had run the `fabrika` binary,
// produced a `.fabrika/lanes/<n>/` directory, and handed it to the renderer.
// "The CLI prints what our parsers expect" was a belief.
//
// `__fixtures__/real/` is the evidence — stdout and on-disk bytes of the real
// binary at a recorded phoenix commit, copied byte for byte. `__fixtures__/real.ts`
// carries the provenance banner and the exact commands. THIS FILE READS THOSE
// BYTES AND NOTHING ELSE: it does not shell out, does not need phoenix present,
// and runs in CI like any other test.
//
// ── WHAT IS PINNED BY REAL ARTIFACTS ──────────────────────────────────────
//
//   The `workflow.json` of a booted coder lane, and of a FOUR-phase epic
//   machine `lane emit` generated from real board topology — so
//   `chartFromWorkflow` is judged against documents this repo did not write.
//
//   `lane status` stdout and `lane history` stdout, verbatim, INCLUDING the
//   trailing newline `verb.ts`'s `answer()` appends. That newline is why this
//   file exists at all: `report.test.ts`'s `fabrikaStdout()` reproduces the
//   bytes "character for character" and does not append it. JSON.parse
//   tolerates it, so nothing broke — but the claim was untested, and now the
//   real bytes are the thing asserted against.
//
//   `events.jsonl`, appended one `lane transition` at a time — so the fold
//   replays a log whose ORDER and TIMESTAMPS came from a real driver, through
//   a retry that spent budget, a park, and a history resume.
//
// ── WHAT IS NOT PINNED BY REAL ARTIFACTS ──────────────────────────────────
//
//   The ORIGINS map (`__fixtures__/origins.ts`). Provenance is not in
//   `workflow.json` and never will be — it is the consumer's statement at the
//   import boundary. It is ours, it stays ours, and the `waiting on:` lines
//   below are only as true as it is.
//
//   The lane KEYS and what they mean. `5673`/`5674` are two runs of the same
//   committed coder template; only `4195` corresponds to a real phoenix epic,
//   and its `## Dependencies` block was transcribed into the grammar
//   `emit.ts`'s own parser reads (see `real.ts` — phoenix #5220).
//
//   The RENDERED markdown. It is this repo's output; the snapshots below are a
//   regression pin on it, not an upstream fact.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { FABRIKA_ORIGINS } from "./__fixtures__/origins";
import {
  REAL_CODER,
  REAL_EPIC,
  REAL_FROZEN,
  REAL_LANES,
} from "./__fixtures__/real";
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
  parseHistoryJson,
  parseStatusJson,
} from "./fold";
import { laneReport } from "./report";
import { laneFromCli, laneFromFiles, reportInput } from "./sources";

const fromFiles = (real: (typeof REAL_LANES)[number]) =>
  laneFromFiles(real.workflowJson, real.eventsJsonl, FABRIKA_ORIGINS);

const fromCli = (real: (typeof REAL_LANES)[number]) =>
  laneFromCli(
    real.workflowJson,
    real.statusStdout,
    real.historyStdout,
    FABRIKA_ORIGINS,
  );

describe("a real workflow.json imports", () => {
  for (const real of REAL_LANES) {
    it(`lane ${real.lane} — ${real.what}`, () => {
      const lane = fromFiles(real).workflow;
      expect(lane.phases.length).toBeGreaterThan(0);
      // Every phase's tasks have a chart, and every chart has an initial state:
      // the import is total over the document, not partial with holes.
      for (const phase of lane.phases) {
        for (const task of phase.tasks) {
          expect(lane.charts[task]).toBeDefined();
        }
      }
    });
  }

  it("the epic machine `lane emit` generated is four phases, twelve tasks", () => {
    const lane = fromFiles(REAL_EPIC).workflow;
    expect(lane.phases.map((p) => p.name)).toEqual([
      "phase1",
      "phase2",
      "phase3",
      "epic",
    ]);
    expect(Object.keys(lane.charts)).toHaveLength(12);
    expect(lane.terminals).toEqual({
      complete: "complete",
      tripped: "tripped",
    });
  });
});

describe("the two input paths agree, on real bytes", () => {
  for (const real of REAL_LANES) {
    it(`lane ${real.lane} renders byte-identical markdown`, () => {
      expect(laneReport(reportInput(fromCli(real))).markdown).toBe(
        laneReport(reportInput(fromFiles(real))).markdown,
      );
    });

    it(`lane ${real.lane} — events.jsonl and \`lane history\` carry the same log`, () => {
      expect(parseHistoryJson(real.historyStdout)).toEqual(
        parseEventsJsonl(real.eventsJsonl),
      );
    });
  }
});

describe("deriveLaneStatus agrees with the real `lane status`, field for field", () => {
  for (const real of REAL_LANES) {
    it(`lane ${real.lane}`, () => {
      const source = fromFiles(real);
      expect(
        deriveLaneStatus(
          source.workflow,
          foldLane(source.workflow, source.entries),
        ),
      ).toEqual(parseStatusJson(real.statusStdout));
    });
  }
});

describe("the vendored oracle still IS the binary", () => {
  // If this fails, `vendor/` has drifted from the phoenix commit `real.ts`
  // names — re-vendor, do not loosen. The `\n` is `answer()`'s.
  for (const real of REAL_LANES) {
    it(`lane ${real.lane} — vendored fold reproduces the real stdout`, () => {
      const compiled = fabrikaCompile(JSON.parse(real.workflowJson));
      if (compiled._tag !== "Compiled")
        throw new Error(compiled.defects.join("; "));
      const parsed = fabrikaParseLog(real.eventsJsonl);
      if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
      const folded = fabrikaFoldLog(compiled.lane, parsed.entries);
      if (folded._tag !== "Folded") throw new Error(folded.defects.join("; "));
      expect(
        `${JSON.stringify(fabrikaDeriveStatus(compiled.lane, folded.states), null, 2)}\n`,
      ).toBe(real.statusStdout);
      expect(`${JSON.stringify(parsed.entries, null, 2)}\n`).toBe(
        real.historyStdout,
      );
    });
  }

  it("real stdout ends in the newline `answer()` appends", () => {
    for (const real of REAL_LANES) {
      expect(real.statusStdout.endsWith("}\n")).toBe(true);
      expect(real.historyStdout.endsWith("]\n")).toBe(true);
    }
  });
});

describe("the report, on a lane that was actually driven", () => {
  it("5673 — WIP, DONE, FAIL(retry), DONE, PASS, BLOCKED, UNBLOCKED, DONE", () => {
    expect(
      laneReport(reportInput(fromFiles(REAL_CODER))).markdown,
    ).toMatchInlineSnapshot(`
        "## coder — done

        **where it is:** \`complete\` — the workflow is done.

        **pipeline:** complete — 1 task: \`issue\` = \`shipped\`

        ### timeline

        | # | at | task | event | from → to |
        |---|---|---|---|---|
        | 1 | 2026-08-18T00:56:24.771Z | \`issue\` | \`ISSUE.WIP\` | \`queued\` → \`build\` |
        | 2 | 2026-08-18T00:56:25.277Z | \`issue\` | \`ISSUE.DONE\` | \`build\` → \`review\` |
        | 3 | 2026-08-18T00:56:25.772Z | \`issue\` | \`ISSUE.FAIL\` | \`review\` → \`build\` |
        | 4 | 2026-08-18T00:56:26.261Z | \`issue\` | \`ISSUE.DONE\` | \`build\` → \`review\` |
        | 5 | 2026-08-18T00:56:26.771Z | \`issue\` | \`ISSUE.PASS\` | \`review\` → \`ship\` |
        | 6 | 2026-08-18T00:56:27.303Z | \`issue\` | \`ISSUE.BLOCKED\` | \`ship\` → \`human:cp-approval\` |
        | 7 | 2026-08-18T00:56:27.803Z | \`issue\` | \`ISSUE.UNBLOCKED\` | \`human:cp-approval\` → \`ship\` |
        | 8 | 2026-08-18T00:56:28.298Z | \`issue\` | \`ISSUE.DONE\` | \`ship\` → \`shipped\` |
        "
      `);
  });

  it("5674 — the same template driven past its retry budget", () => {
    expect(
      laneReport(reportInput(fromFiles(REAL_FROZEN))).markdown,
    ).toMatchInlineSnapshot(`
        "## coder — done

        **where it is:** \`tripped\` — the workflow is done.
        **tripped:** \`issue\` — the lane lands on \`tripped\`

        **pipeline:** tripped — 1 task: \`issue\` = \`frozen\` **(tripped)**

        ### timeline

        | # | at | task | event | from → to |
        |---|---|---|---|---|
        | 1 | 2026-08-18T00:59:23.765Z | \`issue\` | \`ISSUE.WIP\` | \`queued\` → \`build\` |
        | 2 | 2026-08-18T00:59:24.259Z | \`issue\` | \`ISSUE.DONE\` | \`build\` → \`review\` |
        | 3 | 2026-08-18T00:59:24.763Z | \`issue\` | \`ISSUE.FAIL\` | \`review\` → \`build\` |
        | 4 | 2026-08-18T00:59:25.256Z | \`issue\` | \`ISSUE.DONE\` | \`build\` → \`review\` |
        | 5 | 2026-08-18T00:59:25.752Z | \`issue\` | \`ISSUE.FAIL\` | \`review\` → \`build\` |
        | 6 | 2026-08-18T00:59:26.247Z | \`issue\` | \`ISSUE.DONE\` | \`build\` → \`review\` |
        | 7 | 2026-08-18T00:59:26.750Z | \`issue\` | \`ISSUE.FAIL\` | \`review\` → \`frozen\` |
        "
      `);
  });

  // The epic's prose skeleton — every line OUTSIDE a mermaid fence. The fences
  // themselves are asserted below, by the one line that differs between them.
  it("4195 — phase 1 complete, phase 2 running, phases 3 and 4 not started", () => {
    const markdown = laneReport(reportInput(fromFiles(REAL_EPIC))).markdown;
    const kept: string[] = [];
    let inFence = false;
    for (const line of markdown.split("\n")) {
      if (line === "```mermaid") {
        inFence = true;
        continue;
      }
      if (inFence) {
        if (line === "```") inFence = false;
        continue;
      }
      kept.push(line);
    }
    const prose = kept.join("\n");
    expect(prose).toMatchInlineSnapshot(`
      "## epic-4195 — active

      **where it is:** \`phase2\` → \`issue_4240\` = \`review\`, \`issue_4241\` = \`blocked\`, \`issue_4242\` = \`queued\`, \`issue_4243\` = \`queued\`, \`issue_4244\` = \`queued\`, \`issue_4245\` = \`queued\`, \`issue_4246\` = \`queued\`, \`issue_4247\` = \`queued\` · \`phase3\`: waiting · \`epic\`: waiting

      **phase1:** complete — 2 tasks: \`issue_4239\` = \`landed\`, \`issue_4253\` = \`landed\`

      ### issue_4240 — \`review\`
      **waiting on:** the work \`review\` dispatched — \`PASS\`, \`FAIL\` · the operator's \`BLOCKED\`


      ### issue_4241 — \`blocked\`
      **waiting on:** a human's \`UNBLOCKED\`


      **not started yet:** \`issue_4242\`, \`issue_4243\`, \`issue_4244\`, \`issue_4245\`, \`issue_4246\`, \`issue_4247\` — still at \`queued\`.

      **phase3:** waiting — 1 task, not started.

      **epic:** waiting — 1 task, not started.

      ### timeline

      | # | at | task | event | from → to |
      |---|---|---|---|---|
      | 1 | 2026-08-18T00:59:27.745Z | \`issue_4239\` | \`ISSUE_4239.WIP\` | \`queued\` → \`build\` |
      | 2 | 2026-08-18T00:59:28.268Z | \`issue_4239\` | \`ISSUE_4239.DONE\` | \`build\` → \`review\` |
      | 3 | 2026-08-18T00:59:28.777Z | \`issue_4239\` | \`ISSUE_4239.PASS\` | \`review\` → \`integrate\` |
      | 4 | 2026-08-18T00:59:29.264Z | \`issue_4239\` | \`ISSUE_4239.DONE\` | \`integrate\` → \`landed\` |
      | 5 | 2026-08-18T00:59:29.751Z | \`issue_4253\` | \`ISSUE_4253.WIP\` | \`queued\` → \`build\` |
      | 6 | 2026-08-18T00:59:30.247Z | \`issue_4253\` | \`ISSUE_4253.DONE\` | \`build\` → \`review\` |
      | 7 | 2026-08-18T00:59:30.753Z | \`issue_4253\` | \`ISSUE_4253.PASS\` | \`review\` → \`integrate\` |
      | 8 | 2026-08-18T00:59:31.251Z | \`issue_4253\` | \`ISSUE_4253.DONE\` | \`integrate\` → \`landed\` |
      | 9 | 2026-08-18T00:59:31.753Z | \`issue_4240\` | \`ISSUE_4240.WIP\` | \`queued\` → \`build\` |
      | 10 | 2026-08-18T00:59:32.259Z | \`issue_4240\` | \`ISSUE_4240.DONE\` | \`build\` → \`review\` |
      | 11 | 2026-08-18T00:59:32.770Z | \`issue_4241\` | \`ISSUE_4241.BLOCKED\` | \`queued\` → \`blocked\` |
      "
    `);
  });

  it("4195 — a diagram per task that MOVED; the untouched six get one line", () => {
    const markdown = laneReport(reportInput(fromFiles(REAL_EPIC))).markdown;
    const fences = markdown.match(/```mermaid\n[\s\S]*?\n```/g) ?? [];
    // This phase holds eight tasks and six of them have never moved. Drawing
    // the same picture six times with a different node lit is the "comment
    // nobody reads" the module's editorial rule forbids — a task still at its
    // entry state has a one-line story, so it gets one line.
    expect(fences).toHaveLength(2);
    expect(fences.map((f) => /class (\S+) teaActive/.exec(f)?.[1])).toEqual([
      "review",
      "blocked",
    ]);
    expect(markdown).toContain(
      "**not started yet:** `issue_4242`, `issue_4243`, `issue_4244`, `issue_4245`, `issue_4246`, `issue_4247` — still at `queued`.",
    );
    // The walked edges are the real log's, and only the two tasks that moved
    // carry any. `»` is the renderer's walked marker.
    expect(fences[0]).toMatchInlineSnapshot(`
      "\`\`\`mermaid
      stateDiagram-v2
        direction TB
        [*] --> queued
        queued --> build : WIP »
        queued --> blocked : BLOCKED
        build --> review : DONE »
        build --> blocked : BLOCKED
        review --> integrate : PASS
        review --> blocked : BLOCKED
        review --> build : FAIL [retriesRemaining]
        review --> frozen : FAIL [!retriesRemaining]
        integrate --> landed : DONE
        integrate --> blocked : BLOCKED
        integrate --> build : FAIL [retriesRemaining]
        integrate --> frozen : FAIL [!retriesRemaining]
        blocked --> queued : UNBLOCKED (resume)
        landed --> [*]
        frozen --> [*]
        classDef teaTripped stroke-dasharray:4 4
        class frozen teaTripped
        classDef teaShipped stroke-width:2px
        class landed teaShipped
        classDef teaActive fill:#2f81f7,stroke:#2f81f7,color:#fff,font-weight:bold
        class review teaActive
      \`\`\`"
    `);
  });
});
