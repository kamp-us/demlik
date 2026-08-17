// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL EQUIVALENCE — the REAL `examples/resilient-fetch.ts` machine and
// the REDUCER-FORM port, driven through the same message sequence, full state
// and full cmd list diffed at every step.
//
// Determinism: `nextDelayMs` jitters through `defaultRng`, which each copy of
// `retry-backoff` binds to whatever `Math.random` is when THAT copy is first
// imported. The example resolves `@demlik/tea/retry-backoff` (dist); the port
// resolves `../retry-backoff` (src) — two module instances, so installing a
// fresh generator before each dynamic import gives each machine its OWN
// independently-seeded stream. The generator VARIES on every draw, deliberately:
// a constant would hide a difference in how many times each machine draws,
// whereas a varying sequence makes the two agree only if they draw the same
// number of times in the same order.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it, vi } from "vitest";
import { subId } from "../pure/core";
import { importExample } from "./__fixtures__/import-example";
import type { RFState } from "./__fixtures__/resilient-fetch-reducer";

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
const EXAMPLE = new URL("../../examples/resilient-fetch.ts", import.meta.url)
  .href;
const { resilientFetch } = (await importExample(EXAMPLE)) as {
  resilientFetch: { init: unknown; update: unknown };
};

vi.resetModules();
Math.random = lcg();
const { fetchReducerInit, fetchReducerUpdate } = await import(
  "./__fixtures__/resilient-fetch-reducer"
);

type AnyMsg = { readonly type: string; readonly [k: string]: unknown };
type Step = readonly [label: string, msg: AnyMsg];

const T0 = 1_000_000;
const U = "https://api.example/thing";

const steps: readonly Step[] = [
  // a timer that fires before anything started — the phase-conditioned no-op
  [
    "deadline before start",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 },
  ],
  ["fetch", { type: "fetch", url: U, at: T0 }],
  ["fetch_ok", { type: "fetch_ok", url: U, body: "hello", at: T0 + 50 }],
  // served from cache this time — no cmd at all
  ["fetch (cache hit)", { type: "fetch", url: U, at: T0 + 100 }],
  // a different url misses the cache and spends a token
  ["fetch other", { type: "fetch", url: `${U}/b`, at: T0 + 200 }],
  // the failure fork, run to exhaustion — every step here draws from the RNG
  [
    "fetch_err 1",
    { type: "fetch_err", url: `${U}/b`, error: "boom-1", at: T0 + 300 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 400 },
  ],
  [
    "fetch_err 2",
    { type: "fetch_err", url: `${U}/b`, error: "boom-2", at: T0 + 500 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 900 },
  ],
  [
    "fetch_err 3",
    { type: "fetch_err", url: `${U}/b`, error: "boom-3", at: T0 + 1_000 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 1_800 },
  ],
  [
    "fetch_err 4",
    { type: "fetch_err", url: `${U}/b`, error: "boom-4", at: T0 + 1_900 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 3_000 },
  ],
  [
    "fetch_err 5",
    { type: "fetch_err", url: `${U}/b`, error: "boom-5", at: T0 + 3_100 },
  ],
  [
    "fetch_err 6",
    { type: "fetch_err", url: `${U}/b`, error: "boom-6", at: T0 + 3_200 },
  ],
  [
    "fetch_err 7",
    { type: "fetch_err", url: `${U}/b`, error: "boom-7", at: T0 + 3_300 },
  ],
  // adversarial: does a failed machine still absorb traffic identically?
  [
    "deadline after failed",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 4_000 },
  ],
  ["fetch after failed", { type: "fetch", url: `${U}/c`, at: T0 + 4_100 }],
  [
    "fetch_ok late",
    { type: "fetch_ok", url: `${U}/c`, body: "late", at: T0 + 4_200 },
  ],
  // drain the bucket to force the rate-limit fork inside `attempt`
  ...Array.from(
    { length: 14 },
    (_, i): Step => [
      `drain ${i + 1}`,
      { type: "fetch", url: `${U}/d${i}`, at: T0 + 4_300 + i },
    ],
  ),
  [
    "deadline after drain",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 5_000 },
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

type Pair = readonly [Record<string, unknown>, readonly unknown[]];

const origUpdate = resilientFetch.update as unknown as Record<
  string,
  (s: unknown, m: AnyMsg) => Pair
>;
let orig = (
  resilientFetch.init as unknown as (
    l: null,
    c: unknown,
  ) => readonly [Record<string, unknown>]
)(null, {})[0];

// THE SHAPE THAT MATTERS: `fetchReducerUpdate` is a FLAT record keyed by msg
// type — a real `Reducer`, dispatched `update[msg.type](s, m)`, no phase index.
const portUpdate = fetchReducerUpdate as unknown as Record<
  string,
  (s: RFState, m: AnyMsg) => readonly [RFState, readonly unknown[]]
>;
let port: RFState = fetchReducerInit(null)[0];

/** the original names the phase `phase`, the chart names it `type`. Same fact. */
const asOrig = (s: RFState): Record<string, unknown> => {
  const { type, ...rest } = s;
  return { ...rest, phase: type };
};

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

check("<init>", stable(orig), stable(asOrig(port)), "state");

say(
  "step                                  | phase(orig)   | type(port)    | cmds",
);
say(
  "--------------------------------------+---------------+---------------+------",
);

for (const [label, msg] of steps) {
  // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
  const [nextOrig, origCmds] = origUpdate[msg.type]!(orig, msg);
  orig = nextOrig;

  // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
  const [nextPort, portCmds] = portUpdate[msg.type]!(port, msg);
  port = nextPort;

  check(label, stable(orig), stable(asOrig(port)), "state");
  check(label, stable(origCmds), stable(portCmds), "cmds");

  say(
    `${label.padEnd(37)} | ${String(orig.phase).padEnd(13)} | ${port.type.padEnd(13)} | ${
      portCmds.map((c) => (c as { type: string }).type).join(",") || "-"
    }`,
  );
}

say("");
say(`final original: ${stable(orig)}`);
say(`final ported  : ${stable(asOrig(port))}`);

it("the reducer-form port is behaviourally identical to examples/resilient-fetch", () => {
  expect(diffs, transcript.join("\n")).toEqual([]);
});
