// Runtime exercise of the emitted table. Types compiling ≠ the walk working.
import { toMermaid } from "../machine-viz";
import { applyCell } from "../pure/core";
import { initialStateOf } from "./compile";
import { defineGraph } from "./graph";
import { type LaneMsgIn, type LaneState, issue42, lane } from "./lane";
import { laneMachine } from "./machine";
import {
  type UCmd,
  type UMsgIn,
  type UState,
  upload,
  uploadMachine,
  uploader,
} from "./upload";

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

// terminals + unlisted pairs: policy "ignore" self-loops
eq(
  "shipped -WIP-> shipped (unhandled: ignore)",
  step({ type: "shipped", retries: 0, maxRetries: 2 }, {
    type: "ISSUE_42.WIP",
    at: 14,
  }).type,
  "shipped",
);
eq(
  "queued -PASS-> queued (undeclared edge, ignored)",
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

// ═══════════════════════════════════════════════════════════════════════════
// CMDS — the effect half. `lane` emits none, so this runs the `upload` graph.
// ═══════════════════════════════════════════════════════════════════════════
const up = { update: uploader as object, __form: "transitions" as const };
const fire = (s: UState, m: UMsgIn): readonly [UState, readonly UCmd[]] =>
  applyCell<UState, UMsgIn, UCmd>(up, s, m);

const idle: UState = { type: "idle", tries: 0 };

// one named cmd on an edge → one cmd in the SyncReturn tuple, `type` stamped
const [sending, c1] = fire(idle, { type: "up.pick", key: "a/b.png" });
eq("idle -pick-> sending", sending, { key: "a/b.png", tries: 0, type: "sending" });
eq("…emits put_object", c1, [{ key: "a/b.png", type: "put_object" }]);

// a LIST of names → n cmds, in declaration order
const [checking, c2] = fire(sending, { type: "up.done", etag: "e1" });
eq("sending -done-> checking", checking.type, "checking");
eq("…emits [verify_object, log] in order", c2, [
  { key: "a/b.png", etag: "e1", type: "verify_object" },
  { line: "stored a/b.png", type: "log" },
]);

// an edge with NO cmd → zero cmds
const [backIdle, c3] = fire(checking, { type: "up.ok" });
eq("checking -ok-> idle", backIdle.type, "idle");
eq("…emits nothing", c3, []);

// guard TRUE arm → `cmd` fires
const [retry, c4] = fire(sending, { type: "up.fail", error: "5xx" });
eq("sending -fail-> idle (budget)", retry, { tries: 1, type: "idle" });
eq("…emits the then-arm cmd only", c4, [
  { line: "failed a/b.png: 5xx", type: "log" },
]);

// guard FALSE arm → `otherwiseCmd` fires INSTEAD. Conditional effects, in graph.
const spentUp: UState = { type: "sending", key: "a/b.png", tries: 3 };
const [dead, c5] = fire(spentUp, { type: "up.fail", error: "5xx" });
eq("sending -fail-> dead (no budget)", dead, { tries: 3, type: "dead" });
eq("…emits the else-arm cmds", c5, [
  { line: "failed a/b.png: 5xx", type: "log" },
  { reason: "a/b.png dead after 3: 5xx", type: "alert_human" },
]);

// ═══════════════════════════════════════════════════════════════════════════
// INIT — derived from the graph's `initial: true`.
// ═══════════════════════════════════════════════════════════════════════════
eq("graph declares the lane entry", initialStateOf(lane), "queued");
eq("graph declares the upload entry", initialStateOf(upload), "idle");

const ctx = {};
eq("lane init(null) → the declared entry state", laneMachine.init(null, ctx), [
  { retries: 0, maxRetries: 2, type: "queued" },
  [],
]);
// rehydrate: the loaded snapshot comes back VERBATIM, with no cmds
const parked: LaneState = {
  type: "blocked",
  retries: 1,
  maxRetries: 2,
  was: "review",
};
eq("lane init(loaded) → the snapshot, no cmds", laneMachine.init(parked, ctx), [
  parked,
  [],
]);
eq("upload init(null) → idle", uploadMachine.init(null, ctx), [
  { tries: 0, type: "idle" },
  [],
]);

// a graph with no entry marked fails LOUDLY at construction, not at boot
try {
  initialStateOf(defineGraph({ a: { on: { go: "b" } }, b: {} }));
  console.log("FAIL missing `initial` should have thrown");
} catch (e) {
  eq(
    "missing `initial: true` throws",
    (e as Error).message.includes("exactly one state"),
    true,
  );
}

// …and because the entry is DATA, `machine-viz` can draw the `[*]` edge.
eq(
  "machine-viz draws the entry edge from the graph",
  toMermaid(laneMachine, { samples: { ctx: {} } }).includes("[*] --> queued"),
  true,
);
