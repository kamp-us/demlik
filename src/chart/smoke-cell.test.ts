// Runtime exercise of the ESCAPE HATCH. Types compiling ≠ the walk working.
//
// Drives every arm of `resilient-fetch`'s five-way `attempt()` fan-out through
// the compiled table, checks the poller port's cells and the cmds a cell emits,
// and checks that the chart is still drawable — the `to` list gives the FULL
// fan-out, which is more than executing a compiled cell against one sample can
// ever recover.
import { expect, it } from "vitest";
import { set as cacheSet, initCache } from "../cache";
import { toMermaid } from "../machine-viz";
import { applyCell } from "../pure/core";
import { defineMachine } from "../runtime-types";
import {
  type DoFetch,
  type FMsgIn,
  type FState,
  fetchChart,
  fetchInit,
  fetchSubs,
  fetchUpdate,
} from "./__fixtures__/resilient-fetch-chart";
import {
  pollerChart,
  pollerInit,
  pollerUpdate,
} from "./__fixtures__/status-poller-chart";
import { chartMermaid } from "./compile";

/**
 * One assertion → one vitest test. Everything these files assert is computed at
 * module scope from pure data, so registering the case here (rather than
 * wrapping the whole file in one `it`) keeps a failure pointing at the single
 * claim that broke, exactly as the smoke script's per-line output did.
 *
 * The comparison is stable JSON rather than `toEqual`, which is what the script
 * compared — key order included.
 */
const eq = (label: string, got: unknown, want: unknown): void => {
  it(label, () => {
    expect(JSON.stringify(got), label).toBe(JSON.stringify(want));
  });
};

type M = FMsgIn<"RF">;
const rf = { update: fetchUpdate as object, __form: "transitions" as const };
const fire = (s: FState, m: M): readonly [FState, readonly DoFetch[]] =>
  applyCell<FState, M, DoFetch>(rf, s, m);

const idle: FState = fetchInit(null)[0];

// ── the five-way fan-out, one arm at a time ────────────────────────────────
// 1. all gates pass → fetching + the Cmd the cell emitted itself
const [f1, c1] = fire(idle, { type: "RF.fetch", url: "u", at: 1_000 });
eq("idle -fetch-> fetching (gates pass)", f1.type, "fetching");
eq("…cell emitted do_fetch", c1, [{ type: "do_fetch", url: "u" }]);

// 2. cache hit → succeeded, no effect at all
const warm: FState = {
  ...idle,
  cache: cacheSet(initCache<string>(), "u", "cached-body", 1_000, 60_000),
};
const [f2, c2] = fire(warm, { type: "RF.fetch", url: "u", at: 1_500 });
eq("idle -fetch-> succeeded (cache hit)", f2.type, "succeeded");
eq("…body served from cache", f2.body, "cached-body");
eq("…no cmds", c2, []);

// 3. rate-limited with retries left → waiting_retry
// empty bucket stamped at the same instant we fire, so no refill sneaks in
const drained: FState = {
  ...idle,
  bucket: { ...idle.bucket, tokens: 0, lastRefillMs: 1_000 },
};
const [f3, c3] = fire(drained, { type: "RF.fetch", url: "u", at: 1_000 });
eq(
  "idle -fetch-> waiting_retry (no token, retries left)",
  f3.type,
  "waiting_retry",
);
eq("…no cmds", c3, []);
eq("…and only THEN is a retry timer armed", fetchSubs(f3).length, 1);
eq("…while fetching arms none", fetchSubs(f1).length, 0);

// 4. rate-limited AND out of retries → failed
const spent: FState = {
  ...drained,
  retry: { attempt: 99, lastError: "x" },
};
const [f4] = fire(spent, { type: "RF.fetch", url: "u", at: 1_000 });
eq("idle -fetch-> failed (no token, no retries)", f4.type, "failed");
eq("…with the cell's own reason", f4.error, "rate limited; out of retries");

// 5. breaker open → circuit_open
const tripped: FState = {
  ...idle,
  circuit: { phase: "open", openedAtMs: 1_000 },
};
const [f5] = fire(tripped, { type: "RF.fetch", url: "u", at: 1_100 });
eq("idle -fetch-> circuit_open (breaker open)", f5.type, "circuit_open");

// the retry timer re-enters the SAME cell from a different msg
const [f6, c6] = fire(f3, {
  type: "RF.deadline_exceeded",
  id: "retry" as never,
  atMs: 9_000,
});
eq("waiting_retry -deadline-> fetching (bucket refilled)", f6.type, "fetching");
eq("…and re-emits the effect", c6, [{ type: "do_fetch", url: "u" }]);

// a DECLARATIVE edge in the same chart still works the declarative way
const [f7, c7] = fire(f1, {
  type: "RF.fetch_ok",
  url: "u",
  body: "hello",
  at: 2_000,
});
eq("fetching -fetch_ok-> succeeded (assign edge)", f7.type, "succeeded");
eq("…assign filled the payload", f7.body, "hello");
eq("…no cmds", c7, []);

// and an event scoped OUT is still a silent self-loop, cell edges notwithstanding
const [f8, c8] = fire(f1, {
  type: "RF.deadline_exceeded",
  id: "retry" as never,
  atMs: 3_000,
});
eq("fetching -deadline-> fetching (scoped out)", f8.type, "fetching");
eq("…no cmds", c8, []);

// ── the poller port ────────────────────────────────────────────────────────
const p0 = pollerInit(null)[0];
const pu = { update: pollerUpdate as object, __form: "transitions" as const };
const pstep = (s: typeof p0, m: { type: string; [k: string]: unknown }) =>
  applyCell<typeof p0, never, never>(pu, s, m as never);

eq("poller boots at the declared entry", p0.type, "polling");
const [p1, pc1] = pstep(p0, { type: "POLL.start_polling", at: 1_000 });
eq("polling -start-> polling", p1.type, "polling");
eq("…start emits nothing", pc1, []);
const [p2, pc2] = pstep(p1, {
  type: "POLL.deadline_exceeded",
  id: "t",
  atMs: 6_000,
});
eq("polling -tick-> polling", p2.type, "polling");
eq("…and the BATTERY's own cmd comes straight through", pc2, [
  { type: "read_status", jobId: "job-7f3a" },
]);
const [p3] = pstep(p2, {
  type: "POLL.poll_result",
  result: { status: "ready", progress: 100 },
  at: 6_100,
});
eq("polling -ready-> done (battery decided)", p3.type, "done");
eq("…type is the battery's own phase, one writer", p3.type, p3.poll.phase);
const [p4] = pstep(p3, {
  type: "POLL.deadline_exceeded",
  id: "t",
  atMs: 9_000,
});
eq("done -tick-> done (scoped out, no ignore needed)", p4.type, "done");

// ── DRAWING ────────────────────────────────────────────────────────────────
// `chartMermaid` reads the CHART, so a cell edge draws its whole declared
// fan-out — five real edges out of `idle` on `fetch`, not one.
const drawn = chartMermaid(fetchChart);
eq(
  "chartMermaid draws the full 5-way fan-out",
  drawn
    .split("\n")
    .filter((l) => l.startsWith("  idle --> ") && l.includes("fetch /")).length,
  5,
);
eq(
  "…one of them by name",
  drawn.includes("  idle --> circuit_open : fetch / attempt()"),
  true,
);
eq(
  "…and the declarative edge beside it",
  drawn.includes("  idle --> succeeded : fetch_ok"),
  true,
);
eq("…and the entry edge", drawn.includes("  [*] --> idle"), true);
eq(
  "chartMermaid draws the poller's cell fan-out too",
  chartMermaid(pollerChart).includes(
    "  polling --> gave_up : poll_failed / onError()",
  ),
  true,
);

// `machine-viz`'s toMermaid works on the COMPILED machine and resolves a cell
// by executing it against a sample — so it draws the ONE edge that sample takes
// (exactly as it already did for a guarded edge). It must not crash, and the
// edge it does draw must be a real one.
const rfMachine = defineMachine<
  FState,
  M,
  DoFetch,
  never,
  Record<never, never>
>({
  init: fetchInit,
  update: fetchUpdate,
  interpret: { do_fetch: async () => undefined },
});
const viz = toMermaid(rfMachine, {
  samples: {
    ctx: {},
    states: { idle },
    msgs: { "RF.fetch": { type: "RF.fetch", url: "u", at: 1_000 } },
  },
});
eq(
  "toMermaid does not crash on a cell machine",
  viz.startsWith("stateDiagram-v2"),
  true,
);
eq("toMermaid draws the entry edge", viz.includes("[*] --> idle"), true);
eq(
  "toMermaid resolves the sampled cell edge to a REAL target",
  viz.includes("idle --> fetching : RF.fetch"),
  true,
);
