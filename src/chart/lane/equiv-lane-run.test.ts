// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL EQUIVALENCE — the lane RUN and the lane FOLD, driven through the
// same sequence, with the full per-region state AND the full derived lane
// status diffed at every step.
//
// This is the claim the runtime lives or dies by. `foldLane` reconstructs a
// lane from `events.jsonl` and is the thing fabrika's reports, timeline and
// inspector are all built on; `runLane` advances the same lane forward as
// messages arrive. If the two disagree by one step, then either a report lies
// about a run or a run does something the report cannot describe — and the
// disagreement would surface as a support ticket months later, not as a red
// test.
//
// WHAT IS DIFFED, per step, on both sides:
//
//   the per-region leaf         `{ type, retries, maxRetries }` for every task
//   the derived lane status     `deriveLaneStatus(...)` — the compound state
//                               value (active phase → its regions, later phases
//                               `waiting`), the `active`/`done` status, and the
//                               whole context including `errors`
//   the run's own standing      `state.lane` vs what the fold's status says
//
// WHAT IS NOT, and why neither is a hole:
//
//   `was`. The fold records the state you left on EVERY edge; the compiled
//   chart injects it only when entering a parking state, because that is the
//   only place a `resume` edge can read it. The two agree wherever it is read
//   BY CONSTRUCTION rather than by luck: `runLane` restores the fold's rule on
//   a resume — `was` is carried through unchanged, because you are leaving the
//   park rather than entering one — so the compiled cell's re-injection cannot
//   outlive the step. That fix has its own test, over the lane this walk cannot
//   build: `lane-runtime.test.ts`, "a resume between two parking states". THIS
//   comment used to claim the agreement held wherever `was` was read, and it
//   did not — with two mutually reachable parking states the next resume landed
//   the run and the fold on two different `type`s, which no fixture with ONE
//   parking state can show. The walk below still proves the half it can: park
//   `issue_1` from `build`, resume it, and a wrong `was` lands a different
//   `type` and the type diff fires.
//
//   cmds. A fold has none and cannot: it replays events that already happened,
//   so the effects are precisely the part it does not hold. That asymmetry is
//   why the runtime is not the fold with extra steps, and `run.test.ts` pins
//   the cmds on their own.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it } from "vitest";
import {
  deriveLaneStatus,
  foldLane,
  type LogEntry,
  type TaskState,
} from "../report/fold";
import { coderParts, epic } from "./__fixtures__/epic-run";
import { type LaneHands, type LaneRunState, runLane } from "./run";

type Run = LaneRunState<typeof epic>;
type Leaf = {
  readonly type: string;
  readonly retries: number;
  readonly maxRetries: number;
};
type Cell = (
  s: Run,
  m: { readonly type: string; readonly at: number; readonly reason?: string },
) => readonly [Run, readonly unknown[]];

const hands = {
  issue_1: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
  },
  issue_2: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
  },
  // `retries: { issue_3: 5 }` on the lane. The two numbers agreeing is not this
  // fixture being careful: `runLane` reads the budget off `lane.context` — the
  // same field `foldLane` reads — and REFUSES a boot that contradicts it, so a
  // hand copying the wrong number here throws rather than quietly making the
  // two sides freeze at different rounds. (It used to be a coincidence, and a
  // coincidence is what this file exists not to rest on.)
  issue_3: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 5 }),
  },
} satisfies LaneHands<typeof epic>;

/** property-order-independent structural print — `equiv-status-poller`'s. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object")
    return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .filter((k) => rec[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`)
    .join(",")}}`;
}

/** The one shape both sides are read into: name, budget, spend. */
const leaves = (
  states: Readonly<Record<string, Leaf | TaskState>>,
): Readonly<Record<string, Leaf>> => {
  const out: Record<string, Leaf> = {};
  for (const [task, s] of Object.entries(states)) {
    out[task] = {
      type: s.type,
      retries: s.retries,
      maxRetries: s.maxRetries,
    };
  }
  return out;
};

type Step = readonly [task: string, event: string, reason?: string];

/**
 * A walk that reaches `tripped` — through a park-and-resume, a retry ladder
 * that survives, and a retry ladder that does not, with a LATER phase's region
 * moving while the earlier phase is still active (which is what makes the
 * phase standing positional rather than local).
 */
const TRIPS: readonly Step[] = [
  // phase2 moves first — `issue_3` is live long before its phase is.
  ["issue_3", "WIP"],
  ["issue_1", "WIP"],
  ["issue_1", "BLOCKED", "waiting on the operator"],
  ["issue_2", "WIP"],
  // resume: `was` was `build`, so this lands on `build` and not on the
  // fallback `queued`.
  ["issue_1", "UNBLOCKED"],
  ["issue_1", "DONE"],
  ["issue_1", "FAIL", "flaky"],
  ["issue_1", "DONE"],
  ["issue_1", "PASS"],
  ["issue_1", "DONE"],
  ["issue_2", "DONE"],
  ["issue_2", "FAIL", "flaky"],
  ["issue_2", "DONE"],
  ["issue_2", "FAIL", "flaky again"],
  ["issue_2", "DONE"],
  // budget spent: 2 is not < 2 → `frozen`, and phase1 completes tripped.
  ["issue_2", "FAIL", "out of budget"],
  // the lane has ended, and a region of a phase that never ran can still move
  // — the fold folds the whole log, so the runtime must too.
  ["issue_3", "DONE"],
];

/**
 * The same lane, walked to `complete` instead — and walked so that between the
 * two sequences EVERY declared arm of the region chart is driven, including all
 * four targets a `resume` can land on.
 */
const COMPLETES: readonly Step[] = [
  // `issue_1` parks from `ship`, the last place it can.
  ["issue_1", "WIP"],
  ["issue_1", "DONE"],
  ["issue_1", "PASS"],
  ["issue_1", "BLOCKED", "cp approval"],
  ["issue_1", "UNBLOCKED"],
  ["issue_1", "DONE"],
  // `issue_2` parks from `review` — a DIFFERENT resume target off the same
  // edge, which is the whole content of `was`.
  ["issue_2", "WIP"],
  ["issue_2", "DONE"],
  ["issue_2", "BLOCKED", "review queue"],
  ["issue_2", "UNBLOCKED"],
  ["issue_2", "PASS"],
  ["issue_2", "DONE"],
  // …and `issue_3` parks before it has started, so it resumes to `queued`.
  ["issue_3", "BLOCKED", "not picked up yet"],
  ["issue_3", "UNBLOCKED"],
  ["issue_3", "WIP"],
  ["issue_3", "DONE"],
  ["issue_3", "FAIL", "flaky"],
  ["issue_3", "DONE"],
  ["issue_3", "PASS"],
  ["issue_3", "DONE"],
];

const covered = new Set<string>();

/**
 * Drive both machines through one walk, diffing everything at every step.
 * Returns the transcript, printed only when a diff is found.
 */
function walk(
  name: string,
  steps: readonly Step[],
): { readonly diffs: readonly string[]; readonly transcript: string } {
  const rt = runLane(epic, hands);
  const table = rt.update as unknown as Readonly<
    Record<string, Cell | undefined>
  >;
  let run: Run = rt.init(null)[0];
  const log: LogEntry[] = [];
  const diffs: string[] = [];
  const lines: string[] = [`── ${name} ──`];

  const compare = (label: string): void => {
    const folded = foldLane(epic, log);
    const runLeaves = leaves(run.regions as unknown as Record<string, Leaf>);
    const foldLeaves = leaves(folded);
    if (stable(runLeaves) !== stable(foldLeaves)) {
      diffs.push(
        `DIFF (regions) @ ${label}\n    run : ${stable(runLeaves)}\n    fold: ${stable(foldLeaves)}`,
      );
    }
    const runStatus = deriveLaneStatus(epic, runLeaves);
    const foldStatus = deriveLaneStatus(epic, folded);
    if (stable(runStatus) !== stable(foldStatus)) {
      diffs.push(
        `DIFF (status) @ ${label}\n    run : ${stable(runStatus)}\n    fold: ${stable(foldStatus)}`,
      );
    }
    // the run's OWN standing — the field the runtime writes — against what the
    // fold independently derives from the same leaves.
    const expected =
      foldStatus.status === "done" ? foldStatus.stateValue : "running";
    if (run.lane !== expected) {
      diffs.push(
        `DIFF (lane) @ ${label}\n    run : ${String(run.lane)}\n    fold: ${String(expected)}`,
      );
    }
    lines.push(
      `${label.padEnd(34)} | ${Object.entries(runLeaves)
        .map(([t, s]) => `${t}=${s.type}/${s.retries}`)
        .join(" ")
        .padEnd(56)} | ${String(run.lane)}`,
    );
  };

  compare("<boot>");

  for (const [index, [task, event, reason]] of steps.entries()) {
    const key = `${task}.${event}`;
    const cell = table[key];
    if (cell === undefined) throw new Error(`no cell for ${key}`);
    const from = (run.regions as unknown as Record<string, Leaf>)[task]?.type;
    [run] = cell(run, {
      type: key,
      at: index,
      ...(reason === undefined ? {} : { reason }),
    });
    log.push({ task, event: key, at: `t${index}` });
    const to = (run.regions as unknown as Record<string, Leaf>)[task]?.type;
    covered.add(`${String(from)} -${event}-> ${String(to)}`);
    compare(`${index}: ${key}`);
  }

  return { diffs, transcript: lines.join("\n") };
}

const tripped = walk("to tripped", TRIPS);
const completed = walk("to complete", COMPLETES);

it("the run and the fold agree at every step of a walk that TRIPS", () => {
  expect(tripped.diffs, tripped.transcript).toEqual([]);
});

it("the run and the fold agree at every step of a walk that COMPLETES", () => {
  expect(completed.diffs, completed.transcript).toEqual([]);
});

it("the run ends where the fold says it ends", () => {
  const rt = runLane(epic, hands);
  const table = rt.update as unknown as Readonly<
    Record<string, Cell | undefined>
  >;
  const end = (steps: readonly Step[]): string => {
    let run = rt.init(null)[0];
    for (const [index, [task, event, reason]] of steps.entries()) {
      const cell = table[`${task}.${event}`];
      if (cell === undefined) throw new Error("missing cell");
      [run] = cell(run, {
        type: `${task}.${event}`,
        at: index,
        ...(reason === undefined ? {} : { reason }),
      });
    }
    return String(run.lane);
  };
  expect(end(TRIPS)).toBe("tripped");
  expect(end(COMPLETES)).toBe("complete");
});

// ═══════════════════════════════════════════════════════════════════════════
// EDGE COVERAGE — agreeing on a walk is worth exactly what the walk covers.
//
// The region chart declares 10 edges fanning out to 11 arms (the guarded
// `review.FAIL` has two), and a `resume` edge is one edge with as many landings
// as there are states it can be entered from. The list below is every one of
// them: all four resume targets, both arms of the guard, and every `BLOCKED`
// site. Nothing is absent, so nothing is quietly dead — and an edge falling out
// of the sequence fails HERE rather than silently shrinking what "equivalent"
// means.
//
// The one landing that CANNOT appear is `blocked -UNBLOCKED-> queued` reached
// through the edge's declared FALLBACK rather than through `was`: `was` is
// injected on entry and `StateOf` makes it mandatory on a parking state, so a
// region in `blocked` always has one. The fallback is the imported door's net,
// where nothing guarantees that.
// ═══════════════════════════════════════════════════════════════════════════
it("the two walks drive every edge of the region chart", () => {
  expect([...covered].sort()).toEqual([
    "blocked -UNBLOCKED-> build",
    "blocked -UNBLOCKED-> queued",
    "blocked -UNBLOCKED-> review",
    "blocked -UNBLOCKED-> ship",
    "build -BLOCKED-> blocked",
    "build -DONE-> review",
    "queued -BLOCKED-> blocked",
    "queued -WIP-> build",
    "review -BLOCKED-> blocked",
    "review -FAIL-> build",
    "review -FAIL-> frozen",
    "review -PASS-> ship",
    "ship -BLOCKED-> blocked",
    "ship -DONE-> shipped",
  ]);
});
