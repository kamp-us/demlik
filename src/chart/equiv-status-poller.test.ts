// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL EQUIVALENCE — the REAL `examples/status-poller.ts` machine and
// the cell-edge port, driven through the same message sequence, with full
// state, full ordered cmd list AND full sub set diffed at every step.
//
// For a POLLER the subs are the behaviour: the timer wiring is the whole
// machine, and a port that produced identical states and identical cmds while
// arming no deadline would never poll at all. Comparing only `[state, cmds]`
// called that identical — replacing `pollerSubs` with `() => []` left the suite
// green. It does not now.
//
// The walk also covers the graph, not just a happy path: every one of the
// chart's 10 declared edges is driven, and the coverage is ASSERTED at the
// bottom rather than asserted in a comment. Two fan-out arms are named there as
// unreachable, with the reason.
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
import { expect, it, vi } from "vitest";
import { subId } from "../pure/core";
import { deepEqual } from "../trace-replay";
import { importExample } from "./__fixtures__/import-example";
import type { PollState } from "./__fixtures__/status-poller-chart";

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

/**
 * The example is imported for its EXPORTED machine, but the file also calls
 * `main()` at module scope — so `console.log` is muted across the import and
 * restored immediately after. `say` collects the step-by-step table instead of
 * printing it: on a green run nobody reads it, and on a red one vitest prints
 * the whole thing as the failure message.
 */
// The examples log as they boot (`status-poller` even calls `main()` at module
// scope, whose async tail keeps logging long after the import resolves), so the
// mute is permanent for this file rather than restored after the import —
// nothing here writes to stdout: `say` collects the step table into
// `transcript`, which vitest prints only if the equivalence fails.
console.log = () => {};

// Each side must get its OWN module graph, and that is load-bearing rather than
// tidiness: `retry-backoff` captures `defaultRng` from `Math.random` AT MODULE
// LOAD, so two machines sharing one instance share one generator, interleave
// their draws, and diff for a reason that is not a behavioural difference. The
// script version got the separation for free (the example resolved
// `@demlik/tea` to dist/, the port to src/ — two copies). Under vitest the
// alias points both at src/, so the separation has to be asked for.
vi.resetModules();

Math.random = lcg();
// the specifier is a variable so tsc does not pull `examples/` (which compiles
// under its own tsconfig) into this file's program.
const EXAMPLE = new URL("../../examples/status-poller.ts", import.meta.url)
  .href;
const { statusPoller } = (await importExample(EXAMPLE)) as {
  statusPoller: {
    init: unknown;
    update: unknown;
    subscriptions: unknown;
  };
};

vi.resetModules();
Math.random = lcg();
const { pollerInit, pollerUpdate, pollerSubs } = await import(
  "./__fixtures__/status-poller-chart"
);

type AnyMsg = { readonly type: string; readonly [k: string]: unknown };
type Step = readonly [label: string, msg: AnyMsg];

const T0 = 1_000_000;

const steps: readonly Step[] = [
  [
    "tick before start",
    { type: "deadline_exceeded", id: subId("poller:tick:0"), atMs: T0 },
  ],
  ["start", { type: "start_polling", at: T0 }],
  [
    "tick 1",
    { type: "deadline_exceeded", id: subId("poller:tick:1"), atMs: T0 + 5_000 },
  ],
  [
    "pending",
    {
      type: "poll_result",
      result: { status: "pending", progress: 25 },
      at: T0 + 5_010,
    },
  ],
  [
    "tick 2",
    {
      type: "deadline_exceeded",
      id: subId("poller:tick:2"),
      atMs: T0 + 10_010,
    },
  ],
  [
    "pending",
    {
      type: "poll_result",
      result: { status: "pending", progress: 70 },
      at: T0 + 10_020,
    },
  ],
  [
    "tick 3",
    {
      type: "deadline_exceeded",
      id: subId("poller:tick:3"),
      atMs: T0 + 15_020,
    },
  ],
  [
    "ready -> done",
    {
      type: "poll_result",
      result: { status: "ready", progress: 100 },
      at: T0 + 15_030,
    },
  ],
  // adversarial: does a finished poller still absorb traffic identically?
  [
    "tick after done",
    {
      type: "deadline_exceeded",
      id: subId("poller:tick:4"),
      atMs: T0 + 20_000,
    },
  ],
  [
    "late pending after done (resurrect)",
    {
      type: "poll_result",
      result: { status: "pending", progress: 5 },
      at: T0 + 20_010,
    },
  ],
  // the failure fork, run to exhaustion — every step here draws from the RNG
  ["fail 1", { type: "poll_failed", error: "boom-1", at: T0 + 25_000 }],
  ["fail 2", { type: "poll_failed", error: "boom-2", at: T0 + 30_000 }],
  ["fail 3", { type: "poll_failed", error: "boom-3", at: T0 + 35_000 }],
  ["fail 4", { type: "poll_failed", error: "boom-4", at: T0 + 40_000 }],
  ["fail 5", { type: "poll_failed", error: "boom-5", at: T0 + 45_000 }],
  ["fail 6", { type: "poll_failed", error: "boom-6", at: T0 + 50_000 }],
  [
    "tick after gave_up",
    {
      type: "deadline_exceeded",
      id: subId("poller:tick:5"),
      atMs: T0 + 55_000,
    },
  ],
  ["restart from gave_up", { type: "start_polling", at: T0 + 60_000 }],
  [
    "tick 6",
    {
      type: "deadline_exceeded",
      id: subId("poller:tick:6"),
      atMs: T0 + 65_000,
    },
  ],
  [
    "ready -> done again",
    {
      type: "poll_result",
      result: { status: "ready", progress: 100 },
      at: T0 + 65_010,
    },
  ],

  // ── the edges the happy path never touched ───────────────────────────────
  // A success resets the retry counter, so a failure landing on a FINISHED
  // poller always has budget left: `done -poll_failed-> polling` is the only
  // arm of that edge a real run can take (see the coverage assertion below).
  [
    "done -poll_failed-> polling",
    { type: "poll_failed", error: "late-boom", at: T0 + 70_000 },
  ],
  [
    "tick 7",
    {
      type: "deadline_exceeded",
      id: subId("poller:tick:7"),
      atMs: T0 + 75_000,
    },
  ],
  [
    "ready -> done (3rd)",
    {
      type: "poll_result",
      result: { status: "ready", progress: 100 },
      at: T0 + 75_010,
    },
  ],
  // `done -poll_result-> done`: a second terminal observation on an already
  // finished poller — the self-arm of that fan-out.
  [
    "done -poll_result-> done",
    {
      type: "poll_result",
      result: { status: "ready", progress: 100 },
      at: T0 + 76_000,
    },
  ],
  // `done -start_polling-> polling`: restart a finished poller.
  ["done -start_polling-> polling", { type: "start_polling", at: T0 + 80_000 }],

  // back to `gave_up`, to drive the two edges out of it that only a result can
  // take. The retry counter is fresh again (the successes above reset it), so
  // this is a full ladder.
  ...Array.from(
    { length: 6 },
    (_, i): Step => [
      `re-fail ${i + 1}`,
      {
        type: "poll_failed",
        error: `re-boom-${i + 1}`,
        at: T0 + 85_000 + i * 5_000,
      },
    ],
  ),
  // `gave_up -poll_result-> polling`: a late PENDING observation resurrects a
  // given-up poller onto the cadence (the reducer form never declared this
  // unreachable, and the chart says so too).
  [
    "gave_up -poll_result-> polling",
    {
      type: "poll_result",
      result: { status: "pending", progress: 40 },
      at: T0 + 120_000,
    },
  ],
  // …and once more into `gave_up`, this time exited by a TERMINAL observation:
  // `gave_up -poll_result-> done`.
  ...Array.from(
    { length: 6 },
    (_, i): Step => [
      `re-fail b${i + 1}`,
      {
        type: "poll_failed",
        error: `b-boom-${i + 1}`,
        at: T0 + 125_000 + i * 5_000,
      },
    ],
  ),
  [
    "gave_up -poll_result-> done",
    {
      type: "poll_result",
      result: { status: "ready", progress: 100 },
      at: T0 + 160_000,
    },
  ],
];

/** property-order-independent structural print */
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

type Pair = readonly [unknown, readonly unknown[]];

const origUpdate = statusPoller.update as unknown as Record<
  string,
  (s: unknown, m: AnyMsg) => Pair
>;
const origSubs = statusPoller.subscriptions as (
  s: unknown,
) => readonly unknown[];
let orig: unknown = (
  statusPoller.init as unknown as (l: null, c: unknown) => readonly [unknown]
)(null, {})[0];

const portUpdate = pollerUpdate as unknown as Record<
  string,
  Record<
    string,
    (s: PollState, m: AnyMsg) => readonly [PollState, readonly unknown[]]
  >
>;
let port: PollState = pollerInit(null)[0];

const diffs: string[] = [];
const transcript: string[] = [];
const say = (line: string): void => {
  transcript.push(line);
};
const check = (label: string, a: string, b: string, what: string): void => {
  if (a !== b) {
    diffs.push(`DIFF (${what}) @ ${label}
    original: ${a}
    ported  : ${b}`);
  }
};

/**
 * Subs carry an `id`, and a sub SET is identified by those ids, so the compare
 * is order-insensitive but otherwise faithful: sort by id, then hand it to the
 * record/replay lane's own `deepEqual` rather than adding a fourth
 * deep-compare. The poller's tick id ROTATES with the armed target, so this
 * catches a re-arm at the wrong instant as well as a missing timer.
 */
const byId = (subs: readonly unknown[]): readonly unknown[] =>
  [...subs].sort((a, b) =>
    String((a as { id?: unknown }).id).localeCompare(
      String((b as { id?: unknown }).id),
    ),
  );
const checkSubs = (label: string, a: readonly unknown[]): void => {
  const b = pollerSubs(port);
  if (!deepEqual(byId(a), byId(b))) {
    diffs.push(`DIFF (subs) @ ${label}
    original: ${stable(byId(a))}
    ported  : ${stable(byId(b))}`);
  }
};

/** every `state -event-> state` the walk actually drove. */
const covered = new Set<string>();

check(
  "<init>",
  stable(orig),
  stable({ jobId: port.jobId, poll: port.poll }),
  "state",
);
checkSubs("<init>", origSubs(orig));

say(
  "step                                  | phase(orig) | type(port) | subs | cmds",
);
say(
  "--------------------------------------+-------------+------------+------+------",
);

for (const [label, msg] of steps) {
  // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
  const [nextOrig, origCmds] = origUpdate[msg.type]!(orig, msg);
  orig = nextOrig;

  const from = port.type;
  const nsMsg = { ...msg, type: `POLL.${msg.type}` };
  // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
  const [nextPort, portCmds] = portUpdate[port.type]![nsMsg.type]!(port, nsMsg);
  port = nextPort;

  check(
    label,
    stable(orig),
    stable({ jobId: port.jobId, poll: port.poll }),
    "state",
  );
  check(label, stable(origCmds), stable(portCmds), "cmds");
  checkSubs(label, origSubs(orig));
  // `deadline_exceeded` is routed ONLY out of `polling`; from `done`/`gave_up`
  // it is a scoped-out self-loop, not an edge, so it is not counted as one.
  if (msg.type !== "deadline_exceeded" || from === "polling") {
    covered.add(`${from} -${msg.type}-> ${port.type}`);
  }

  // the chart's `type` and the battery's `phase` have ONE writer between them
  // (the cell's `type: slice.phase`), so this can never desync — asserted, not
  // assumed.
  if (port.type !== port.poll.phase) {
    diffs.push(
      `DESYNC @ ${label}: type="${port.type}" phase="${port.poll.phase}"`,
    );
  }
  const o = orig as { poll: { phase: string } };
  say(
    `${label.padEnd(37)} | ${o.poll.phase.padEnd(11)} | ${port.type.padEnd(10)} | ${String(
      pollerSubs(port).length,
    ).padEnd(
      4,
    )} | ${portCmds.map((c) => (c as { type: string }).type).join(",") || "-"}`,
  );
}

say("");
say(`final original: ${stable(orig)}`);
say(`final ported  : ${stable({ jobId: port.jobId, poll: port.poll })}`);

it("the cell-edge port is behaviourally identical to examples/status-poller", () => {
  expect(diffs, transcript.join("\n")).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// EDGE COVERAGE — agreeing on a walk is only worth as much as the walk covers.
//
// The chart declares 10 edges fanning out to 16 targets. This pins exactly which
// of those 16 the sequence lands, so an edge silently falling out of the walk
// fails here instead of quietly reducing what "equivalent" means.
//
// TWO arms are absent, and both are UNREACHABLE rather than untested — the
// chart declares them because `to` can be no tighter than the delegate's return
// type, and `tickErr` genuinely returns `PollerPolling | PollerGaveUp` from any
// input:
//
//   done -poll_failed-> gave_up    Reaching `done` means a `tickResult` with
//                                  `untilHeld`, which resets `retry` to
//                                  `initRetry()`. The next failure is therefore
//                                  attempt 1 of 5, and `shouldRetry` always
//                                  permits it. Only a `maxAttempts: 1` policy
//                                  could land this arm.
//   gave_up -poll_failed-> polling `gave_up` is entered precisely when
//                                  `shouldRetry` returned false, and another
//                                  `recordFailure` only advances the counter
//                                  further past the bound. Under the count
//                                  policy this chart uses, once refused always
//                                  refused.
//
// Both are declared honestly and drawn honestly; what is asserted here is that
// nothing ELSE is quietly dead.
// ═══════════════════════════════════════════════════════════════════════════
it("the sequence drives every reachable edge of the chart", () => {
  expect([...covered].sort(), transcript.join("\n")).toEqual([
    "done -poll_failed-> polling",
    "done -poll_result-> done",
    "done -poll_result-> polling",
    "done -start_polling-> polling",
    "gave_up -poll_failed-> gave_up",
    "gave_up -poll_result-> done",
    "gave_up -poll_result-> polling",
    "gave_up -start_polling-> polling",
    "polling -deadline_exceeded-> polling",
    "polling -poll_failed-> gave_up",
    "polling -poll_failed-> polling",
    "polling -poll_result-> done",
    "polling -poll_result-> polling",
    "polling -start_polling-> polling",
  ]);
});
