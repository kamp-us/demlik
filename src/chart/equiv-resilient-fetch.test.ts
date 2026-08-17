// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL EQUIVALENCE — the REAL `examples/resilient-fetch.ts` machine and
// the REDUCER-FORM port, driven through the same message sequence, with full
// state, full ordered cmd list AND full sub set diffed at every step.
//
// The sequence lives in `__fixtures__/resilient-fetch-steps.ts`, shared with the
// GRID-form twin `equiv-resilient-fetch-chart.test.ts` — an equivalence claim
// about "the ports" is only as strong as its weaker walk. That file also asserts
// which arms of the five-way `attempt()` fan-out the walk actually lands.
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
import { deepEqual } from "../trace-replay";
import { importExample } from "./__fixtures__/import-example";
import type { RFState } from "./__fixtures__/resilient-fetch-reducer";
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
  resilientFetch: { init: unknown; update: unknown; subscriptions: unknown };
};

vi.resetModules();
Math.random = lcg();
const { fetchReducerInit, fetchReducerUpdate, fetchReducerSubs } = await import(
  "./__fixtures__/resilient-fetch-reducer"
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

/**
 * SUBS ARE PART OF THE MACHINE. Both the example and the port declare
 * `subscriptions`, and for the retry ladder the timer IS the behaviour — a port
 * that emitted the right states and the right cmds but armed no deadline would
 * simply never retry, and comparing only `[state, cmds]` called that identical.
 *
 * Subs carry an `id`, and a sub SET is identified by those ids, so the compare
 * is order-insensitive but otherwise faithful: sort by id, then hand it to the
 * record/replay lane's own `deepEqual` rather than adding a fourth deep-compare.
 */
const byId = (subs: readonly unknown[]): readonly unknown[] =>
  [...subs].sort((a, b) =>
    String((a as { id?: unknown }).id).localeCompare(
      String((b as { id?: unknown }).id),
    ),
  );
const checkSubs = (label: string, a: readonly unknown[]): void => {
  const b = fetchReducerSubs(port);
  if (!deepEqual(byId(a), byId(b))) {
    diffs.push(`DIFF (subs) @ ${label}
    original: ${stable(byId(a))}
    ported  : ${stable(byId(b))}`);
  }
};

say(
  "step                                  | phase(orig)   | type(port)    | subs | cmds",
);
say(
  "--------------------------------------+---------------+---------------+------+------",
);

for (const walk of walks) {
  // A fresh `init` per walk, on BOTH machines — `idle` is the one state nothing
  // targets, so a walk can only ask it one question. The RNG streams are NOT
  // reset between walks: each machine keeps one stream end to end, so the two
  // agree only if they draw the same number of times in the same order.
  orig = origInit(null, {})[0];
  port = fetchReducerInit(null)[0];
  say(`— walk: ${walk.name} —`);
  check(`<init:${walk.name}>`, stable(orig), stable(asOrig(port)), "state");
  checkSubs(`<init:${walk.name}>`, origSubs(orig));

  for (const [label, msg] of walk.steps) {
    // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
    const [nextOrig, origCmds] = origUpdate[msg.type]!(orig, msg);
    orig = nextOrig;

    // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
    const [nextPort, portCmds] = portUpdate[msg.type]!(port, msg);
    port = nextPort;

    check(label, stable(orig), stable(asOrig(port)), "state");
    check(label, stable(origCmds), stable(portCmds), "cmds");
    checkSubs(label, origSubs(orig));

    say(
      `${label.padEnd(37)} | ${String(orig.phase).padEnd(13)} | ${port.type.padEnd(13)} | ${String(
        fetchReducerSubs(port).length,
      ).padEnd(
        4,
      )} | ${portCmds.map((c) => (c as { type: string }).type).join(",") || "-"}`,
    );
  }
}
say("");
say(`final original: ${stable(orig)}`);
say(`final ported  : ${stable(asOrig(port))}`);

it("the reducer-form port is behaviourally identical to examples/resilient-fetch", () => {
  expect(diffs, transcript.join("\n")).toEqual([]);
});
