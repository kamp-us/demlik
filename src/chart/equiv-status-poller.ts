// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL EQUIVALENCE — the REAL `examples/status-poller.ts` machine and
// the cell-edge port, driven through the same message sequence, full state and
// full cmd list diffed at every step.
//
// Determinism: the poller's backoff draws from `Math.random`, captured at
// `createPoller` time. It is replaced below by a SEEDED LCG that returns a
// DIFFERENT value on every draw — deliberately, not a constant. A constant
// would hide a difference in how many times each machine draws; a varying
// sequence makes the two agree only if they draw the same number of times in
// the same order. The old guard-based port could not have passed this: its
// `backoffExhausted` guard ran `tickErr` a second time per failure and burned
// an extra draw. Nothing in this port re-runs a battery verb.
// ═══════════════════════════════════════════════════════════════════════════
import { subId } from "../pure/core";
import type { PollState } from "./status-poller-chart";

/** Two INDEPENDENT generators off the same seed — one per machine, so a shared
 *  stream cannot interleave the two machines' draws and manufacture a diff.
 *  `createPoller(config, rng = Math.random)` captures whatever `Math.random` is
 *  at construction time, and each module constructs its poller at import time,
 *  so installing a fresh generator before each dynamic import binds it. */
const lcg = (): (() => number) => {
  let seed = 0x2f6e2b1;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
};

// The example file calls `main()` at module scope. Silence it; we drive the
// exported machine ourselves.
const realLog = console.log.bind(console);
console.log = () => {};
Math.random = lcg();
// the specifier is a variable so tsc does not pull `examples/` (which compiles
// under its own tsconfig) into this file's program.
const EXAMPLE = "../../examples/status-poller";
const { statusPoller } = (await import(EXAMPLE)) as {
  statusPoller: {
    init: unknown;
    update: unknown;
  };
};
Math.random = lcg();
const { pollerInit, pollerUpdate } = await import("./status-poller-chart");
const say = (line: string): void => {
  realLog(line);
};

type AnyMsg = { readonly type: string; readonly [k: string]: unknown };
type Step = readonly [label: string, msg: AnyMsg];

const T0 = 1_000_000;

const steps: readonly Step[] = [
  ["tick before start", { type: "deadline_exceeded", id: subId("poller:tick:0"), atMs: T0 }],
  ["start", { type: "start_polling", at: T0 }],
  ["tick 1", { type: "deadline_exceeded", id: subId("poller:tick:1"), atMs: T0 + 5_000 }],
  ["pending", { type: "poll_result", result: { status: "pending", progress: 25 }, at: T0 + 5_010 }],
  ["tick 2", { type: "deadline_exceeded", id: subId("poller:tick:2"), atMs: T0 + 10_010 }],
  ["pending", { type: "poll_result", result: { status: "pending", progress: 70 }, at: T0 + 10_020 }],
  ["tick 3", { type: "deadline_exceeded", id: subId("poller:tick:3"), atMs: T0 + 15_020 }],
  ["ready -> done", { type: "poll_result", result: { status: "ready", progress: 100 }, at: T0 + 15_030 }],
  // adversarial: does a finished poller still absorb traffic identically?
  ["tick after done", { type: "deadline_exceeded", id: subId("poller:tick:4"), atMs: T0 + 20_000 }],
  ["late pending after done (resurrect)", { type: "poll_result", result: { status: "pending", progress: 5 }, at: T0 + 20_010 }],
  // the failure fork, run to exhaustion — every step here draws from the RNG
  ["fail 1", { type: "poll_failed", error: "boom-1", at: T0 + 25_000 }],
  ["fail 2", { type: "poll_failed", error: "boom-2", at: T0 + 30_000 }],
  ["fail 3", { type: "poll_failed", error: "boom-3", at: T0 + 35_000 }],
  ["fail 4", { type: "poll_failed", error: "boom-4", at: T0 + 40_000 }],
  ["fail 5", { type: "poll_failed", error: "boom-5", at: T0 + 45_000 }],
  ["fail 6", { type: "poll_failed", error: "boom-6", at: T0 + 50_000 }],
  ["tick after gave_up", { type: "deadline_exceeded", id: subId("poller:tick:5"), atMs: T0 + 55_000 }],
  ["restart from gave_up", { type: "start_polling", at: T0 + 60_000 }],
  ["tick 6", { type: "deadline_exceeded", id: subId("poller:tick:6"), atMs: T0 + 65_000 }],
  ["ready -> done again", { type: "poll_result", result: { status: "ready", progress: 100 }, at: T0 + 65_010 }],
];

/** property-order-independent structural print */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .filter((k) => rec[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`)
    .join(",")}}`;
}

type Pair = readonly [unknown, readonly unknown[]];

const origUpdate = statusPoller.update as unknown as Record<
  string,
  (s: unknown, m: AnyMsg) => Pair
>;
let orig: unknown = (
  statusPoller.init as unknown as (l: null, c: unknown) => readonly [unknown]
)(null, {})[0];

const portUpdate = pollerUpdate as unknown as Record<
  string,
  Record<string, (s: PollState, m: AnyMsg) => readonly [PollState, readonly unknown[]]>
>;
let port: PollState = pollerInit(null)[0];

let diffs = 0;
const check = (label: string, a: string, b: string, what: string): void => {
  if (a !== b) {
    diffs += 1;
    say(`  DIFF (${what}) @ ${label}\n    original: ${a}\n    ported  : ${b}`);
  }
};

check("<init>", stable(orig), stable({ jobId: port.jobId, poll: port.poll }), "state");

say("step                                  | phase(orig) | type(port) | cmds");
say("--------------------------------------+-------------+------------+------");

for (const [label, msg] of steps) {
  const [nextOrig, origCmds] = origUpdate[msg.type]!(orig, msg);
  orig = nextOrig;

  const nsMsg = { ...msg, type: `POLL.${msg.type}` };
  const [nextPort, portCmds] = portUpdate[port.type]![nsMsg.type]!(port, nsMsg);
  port = nextPort;

  check(label, stable(orig), stable({ jobId: port.jobId, poll: port.poll }), "state");
  check(label, stable(origCmds), stable(portCmds), "cmds");

  // the chart's `type` and the battery's `phase` have ONE writer between them
  // (the cell's `type: slice.phase`), so this can never desync — asserted, not
  // assumed.
  if (port.type !== port.poll.phase) {
    diffs += 1;
    say(`  DESYNC @ ${label}: type="${port.type}" phase="${port.poll.phase}"`);
  }
  const o = orig as { poll: { phase: string } };
  say(
    `${label.padEnd(37)} | ${o.poll.phase.padEnd(11)} | ${port.type.padEnd(10)} | ${portCmds.map((c) => (c as { type: string }).type).join(",") || "-"}`,
  );
}

say("");
say(`final original: ${stable(orig)}`);
say(`final ported  : ${stable({ jobId: port.jobId, poll: port.poll })}`);
say("");
say(
  diffs === 0
    ? `EQUIVALENT — ${steps.length} steps, ${steps.length * 2 + 1} comparisons, 0 diffs`
    : `${diffs} DIFFS`,
);
if (diffs > 0) process.exitCode = 1;
