// Runtime exercise of the emitted table. Types compiling ≠ the walk working.
import { applyCell } from "../pure/core";
import { type LaneMsgIn, type LaneState, issue42 } from "./lane";

type M = LaneMsgIn<"ISSUE_42">;
const machine = { update: issue42 as object, __form: "transitions" as const };
const step = (s: LaneState, m: M): LaneState =>
  applyCell<LaneState, M, never>(machine, s, m)[0];

const eq = (label: string, got: unknown, want: unknown): void => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  console.log(`${g === w ? "ok  " : "FAIL"} ${label}  got=${g} want=${w}`);
};

const start: LaneState = { type: "queued", retries: 0, maxRetries: 2 };

// happy path
const b = step(start, { type: "ISSUE_42.WIP", at: 1 });
eq("queued -WIP-> build", b, { retries: 0, maxRetries: 2, type: "build" });
const r = step(b, { type: "ISSUE_42.DONE", at: 2 });
eq("build -DONE-> review", r.type, "review");
eq("review -PASS-> ship", step(r, { type: "ISSUE_42.PASS", at: 3 }).type, "ship");

// guard true → back to build, retries incremented
const f1 = step(r, { type: "ISSUE_42.FAIL", at: 4, reason: "flake" });
eq("review -FAIL-> build (guard true)", f1, {
  retries: 1,
  maxRetries: 2,
  type: "build",
});
// guard false (retries exhausted) → frozen
const spent: LaneState = { type: "review", retries: 2, maxRetries: 2 };
eq(
  "review -FAIL-> frozen (guard false)",
  step(spent, { type: "ISSUE_42.FAIL", at: 5, reason: "flake" }).type,
  "frozen",
);
// guard reads the MSG too
eq(
  "review -FAIL-> frozen (fatal reason)",
  step(r, { type: "ISSUE_42.FAIL", at: 6, reason: "fatal" }).type,
  "frozen",
);

// `was` is injected on entry to a parking state, from three different sources
const blockedFromReview = step(r, { type: "ISSUE_42.BLOCKED", at: 7, reason: "x" });
eq("review -BLOCKED-> blocked", blockedFromReview, {
  retries: 0,
  maxRetries: 2,
  type: "blocked",
  was: "review",
});
// …and the resume edge lands back on it
eq(
  "blocked -UNBLOCKED-> was(review)",
  step(blockedFromReview, { type: "ISSUE_42.UNBLOCKED", at: 8 }).type,
  "review",
);
eq(
  "blocked -UNBLOCKED-> was(queued)",
  step(step(start, { type: "ISSUE_42.BLOCKED", at: 9, reason: "x" }), {
    type: "ISSUE_42.UNBLOCKED",
    at: 10,
  }).type,
  "queued",
);
// fallback when `was` is absent (a rehydrated/hand-built parked state)
eq(
  "blocked -UNBLOCKED-> fallback",
  step({ type: "blocked", retries: 0, maxRetries: 2 } as unknown as LaneState, {
    type: "ISSUE_42.UNBLOCKED",
    at: 11,
  }).type,
  "queued",
);

// ship blocks to the human gate, which resumes to ship
const cp = step(
  { type: "ship", retries: 0, maxRetries: 2 },
  { type: "ISSUE_42.BLOCKED", at: 12, reason: "needs cp" },
);
eq("ship -BLOCKED-> human:cp-approval", cp, {
  retries: 0,
  maxRetries: 2,
  type: "human:cp-approval",
  was: "ship",
});
eq(
  "cp-approval -UNBLOCKED-> was(ship)",
  step(cp, { type: "ISSUE_42.UNBLOCKED", at: 13 }).type,
  "ship",
);

// refused pairs self-loop: `end: true` on a terminal, `ignore` on a live state
eq(
  "shipped -WIP-> shipped (end: true)",
  step({ type: "shipped", retries: 0, maxRetries: 2 }, {
    type: "ISSUE_42.WIP",
    at: 14,
  }).type,
  "shipped",
);
eq(
  "queued -PASS-> queued (declared refusal: ignore)",
  step(start, { type: "ISSUE_42.PASS", at: 15 }).type,
  "queued",
);

// namespace really is on the wire: a foreign namespace finds no cell
try {
  step(start, { type: "OTHER.WIP" } as unknown as M);
  console.log("FAIL foreign namespace should have thrown");
} catch (e) {
  eq("foreign namespace throws NoCellError", (e as Error).name, "NoCellError");
}
