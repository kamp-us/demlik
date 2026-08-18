// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL EQUIVALENCE — the REAL `examples/resilient-fetch.ts` machine and
// the GRID-FORM (`defineChart` / `compile`) port, driven through the same
// message sequence, with full state, full ordered cmd list AND full sub set
// diffed at every step.
//
// This is the suite the grid form did not have. `resilient-fetch-chart.ts` is
// 305 lines and 19 edges, and until this file existed only its `idle` row was
// ever fired — by `smoke-cell.test.ts`, one state, one arm at a time. A chart
// whose `succeeded.fetch_ok` pointed at `failed` (a machine that moves to
// `failed` on SUCCESS) passed typecheck and the whole suite.
//
// It is the twin of `equiv-resilient-fetch.test.ts`, which does the same for the
// reducer form, and it shares that suite's step list on purpose: an equivalence
// claim about "the ports" is only as strong as its weaker sequence.
//
// Determinism: `nextDelayMs` jitters through `defaultRng`, which each copy of
// `retry-backoff` binds to whatever `Math.random` is when THAT copy is first
// imported. `vi.resetModules()` before each dynamic import gives the example and
// the port their OWN module graph, and each gets its OWN independently-seeded
// LCG. The generator VARIES on every draw, deliberately: a constant would hide a
// difference in how many times each machine draws, whereas a varying sequence
// makes the two agree only if they draw the same number of times in the same
// order. (Offset one side by a single draw and this file goes red — that is the
// check that the determinism is real rather than accidental.)
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it, vi } from "vitest";
import { deepEqual } from "../trace-replay";
import { importExample } from "./__fixtures__/import-example";
import type { FState } from "./__fixtures__/resilient-fetch-chart";
import {
  type AnyMsg,
  stable,
  walks,
} from "./__fixtures__/resilient-fetch-steps";

const lcg = (): (() => number) => {
  let seed = 0x2f6e2b1;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
};

// The examples log as they boot, so the mute is permanent for this file rather
// than restored after the import — nothing here writes to stdout: `say` collects
// the step table into `transcript`, which vitest prints only if a diff appears.
console.log = () => {};

vi.resetModules();
Math.random = lcg();
// the specifier is a variable so tsc does not pull `examples/` (which compiles
// under its own tsconfig) into this file's program.
const EXAMPLE = new URL("../../examples/resilient-fetch.ts", import.meta.url)
  .href;
const { resilientFetch } = (await importExample(EXAMPLE)) as {
  resilientFetch: { init: unknown; update: unknown; subscriptions: unknown };
};

vi.resetModules();
Math.random = lcg();
const { fetchInit, fetchUpdate, fetchSubs } = await import(
  "./__fixtures__/resilient-fetch-chart"
);

type Pair = readonly [Record<string, unknown>, readonly unknown[]];

const origUpdate = resilientFetch.update as unknown as Record<
  string,
  (s: unknown, m: AnyMsg) => Pair
>;
const origSubs = resilientFetch.subscriptions as (
  s: unknown,
) => readonly unknown[];
const origInit = resilientFetch.init as unknown as (
  l: null,
  c: unknown,
) => readonly [Record<string, unknown>];
let orig = origInit(null, {})[0];

// THE SHAPE THAT MATTERS: `fetchUpdate` is a `Transitions` table — indexed by
// the STATE first and the (namespaced) msg type second, which is the grid form's
// whole point and exactly what the reducer form does not have.
const portUpdate = fetchUpdate as unknown as Record<
  string,
  Record<
    string,
    (s: FState, m: AnyMsg) => readonly [FState, readonly unknown[]]
  >
>;
let port: FState = fetchInit(null)[0];

/** the original names the phase `phase`, the chart names it `type`. Same fact. */
const asOrig = (s: FState): Record<string, unknown> => {
  const { type, ...rest } = s;
  return { ...rest, phase: type };
};

/**
 * Subs carry an `id`, and a sub SET is identified by those ids — so the
 * comparison is order-insensitive but otherwise faithful: sort by id, then
 * compare structurally with the record/replay lane's own `deepEqual` rather
 * than adding a fourth deep-compare.
 */
const byId = (subs: readonly unknown[]): readonly unknown[] =>
  [...subs].sort((a, b) =>
    String((a as { id?: unknown }).id).localeCompare(
      String((b as { id?: unknown }).id),
    ),
  );

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
const checkSubs = (label: string, a: readonly unknown[]): void => {
  const b = fetchSubs(port);
  if (!deepEqual(byId(a), byId(b))) {
    diffs.push(`DIFF (subs) @ ${label}
    original: ${stable(byId(a))}
    ported  : ${stable(byId(b))}`);
  }
};

/** Which arms of the five-way `attempt()` fan-out these walks actually landed. */
const reached = new Set<string>();
/** every `state -event->` PAIR the walks drove — one per declared chart edge. */
const pairs = new Set<string>();

say(
  "step                                  | phase(orig)   | type(port)    | subs | cmds",
);
say(
  "--------------------------------------+---------------+---------------+------+------",
);

for (const walk of walks) {
  // A fresh `init` per walk, on BOTH machines. `idle` is the one state nothing
  // targets, so a single walk can only ever ask it one question; its other rows
  // need their own walk. The RNG streams are NOT reset — each machine keeps its
  // own single stream across all walks, so the two still agree only if they draw
  // the same number of times in the same order end to end.
  orig = origInit(null, {})[0];
  port = fetchInit(null)[0];
  say(`— walk: ${walk.name} —`);
  check(`<init:${walk.name}>`, stable(orig), stable(asOrig(port)), "state");
  checkSubs(`<init:${walk.name}>`, origSubs(orig));

  for (const [label, msg] of walk.steps) {
    // `attempt()` runs on EVERY `fetch`, and on `deadline_exceeded` only while
    // parked in `waiting_retry` (the one state whose row declares that edge).
    // Everywhere else the timer is a scoped-out self-loop, and counting its
    // no-op as a landed arm would inflate the coverage claim below.
    const ranAttempt =
      msg.type === "fetch" ||
      (msg.type === "deadline_exceeded" && port.type === "waiting_retry");
    // `deadline_exceeded` is a declared EDGE only out of `waiting_retry`;
    // everywhere else it is a scoped-out self-loop, not an edge.
    if (msg.type !== "deadline_exceeded" || port.type === "waiting_retry") {
      pairs.add(`${port.type}.${msg.type}`);
    }

    // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
    const [nextOrig, origCmds] = origUpdate[msg.type]!(orig, msg);
    orig = nextOrig;

    // the grid form dispatches on the STATE first, and every event is namespaced.
    const nsType = `RF.${msg.type}`;
    // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over (state × event) by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
    const [nextPort, portCmds] = portUpdate[port.type]![nsType]!(port, {
      ...msg,
      type: nsType,
    });
    port = nextPort;

    check(label, stable(orig), stable(asOrig(port)), "state");
    check(label, stable(origCmds), stable(portCmds), "cmds");
    checkSubs(label, origSubs(orig));

    if (ranAttempt) {
      // `failed` is reachable through `attempt` only by the rate-limit arm, and it
      // is the one arm with its own reason string — so the two `failed`s are told
      // apart by the fact the cell itself wrote.
      reached.add(
        port.type === "failed" && port.error === "rate limited; out of retries"
          ? "failed(rate-limited)"
          : port.type,
      );
    }

    say(
      `${label.padEnd(37)} | ${String(orig.phase).padEnd(13)} | ${port.type.padEnd(13)} | ${String(
        fetchSubs(port).length,
      ).padEnd(
        4,
      )} | ${portCmds.map((c) => (c as { type: string }).type).join(",") || "-"}`,
    );
  }
}
say("");
say(`final original: ${stable(orig)}`);
say(`final ported  : ${stable(asOrig(port))}`);

it("the grid-form port is behaviourally identical to examples/resilient-fetch", () => {
  expect(diffs, transcript.join("\n")).toEqual([]);
});

// The equivalence above only proves the two machines AGREE. This says the walk
// was worth agreeing about: every arm of the five-way fan-out was actually
// landed, including the two rate-limit arms that no sequence reached before —
// the breaker trips on the failure ladder first, so the bucket has to be drained
// EARLY, while `canPass` still lets the call through to `tryConsume`.
it("the walks land every arm of the five-way `attempt()` fan-out", () => {
  expect([...reached].sort(), transcript.join("\n")).toEqual([
    "circuit_open",
    "failed(rate-limited)",
    "fetching",
    "succeeded",
    "waiting_retry",
  ]);
});

// …and the walks cover the GRAPH, not just the interesting corners of it. The
// chart declares 19 edges — six states × the three `run` events, plus
// `waiting_retry`'s retry timer — and every one of them is driven below. This is
// what makes the equivalence a statement about the chart rather than about one
// path through it: `succeeded.fetch_ok` pointing at `failed` (a machine that
// moves to `failed` on SUCCESS) used to pass typecheck and the whole suite.
it("the walks drive all 19 declared edges of the chart", () => {
  expect([...pairs].sort(), transcript.join("\n")).toEqual([
    "circuit_open.fetch",
    "circuit_open.fetch_err",
    "circuit_open.fetch_ok",
    "failed.fetch",
    "failed.fetch_err",
    "failed.fetch_ok",
    "fetching.fetch",
    "fetching.fetch_err",
    "fetching.fetch_ok",
    "idle.fetch",
    "idle.fetch_err",
    "idle.fetch_ok",
    "succeeded.fetch",
    "succeeded.fetch_err",
    "succeeded.fetch_ok",
    "waiting_retry.deadline_exceeded",
    "waiting_retry.fetch",
    "waiting_retry.fetch_err",
    "waiting_retry.fetch_ok",
  ]);
});
