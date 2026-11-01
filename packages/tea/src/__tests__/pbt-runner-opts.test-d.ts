// Type-level test for what the property runners take and hand back (#747).
// Compiled by `pnpm typecheck`. Each `@ts-expect-error` MUST sit on a line that
// genuinely fails to type-check: if a setting that would break a runner's promise
// ever comes back, the directive turns "unused" and `tsc` fails the package.

import * as fc from "fast-check";
import type { Machine } from "../index";
import {
  PropertyFailure,
  type PropertyRun,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "../pbt";

type State = { readonly type: "idle" } | { readonly type: "done" };
type Msg = { readonly type: "finish" };

declare const machine: Machine<State, Msg, never, never, object>;
declare const seqArb: fc.Arbitrary<readonly Msg[]>;
declare const stateArb: fc.Arbitrary<State>;
declare const otherArb: fc.Arbitrary<{ readonly other: true }>;

const terminal = (s: State) => s.type === "done";

// A failing run can't pass through a forwarded setting.
propertyTerminates(machine, {}, seqArb, terminal, {
  // @ts-expect-error a reporter stops a failing run from throwing
  reporter: () => {},
});
propertyInvariant(machine, {}, seqArb, () => true, {
  // @ts-expect-error an async reporter stops a failing run from throwing
  asyncReporter: async () => {},
});
propertyTrace(machine, {}, seqArb, () => true, {
  // @ts-expect-error examples has the shape of the drawn tuple
  examples: [],
});
propertyTrace(machine, {}, seqArb, () => true, {
  // @ts-expect-error timeout does nothing on a sync run
  timeout: 1,
});

// `loaded` is a state, null, or an arbitrary of the machine's state that can
// also draw null: what storage hands back on a fresh start.
propertyTrace(machine, {}, seqArb, () => true, { loaded: { type: "idle" } });
propertyTrace(machine, {}, seqArb, () => true, { loaded: null });
propertyTrace(machine, {}, seqArb, () => true, { loaded: stateArb });
propertyTrace(machine, {}, seqArb, () => true, {
  loaded: fc.oneof(fc.constant(null), stateArb),
});
propertyTrace(machine, {}, seqArb, () => true, {
  // @ts-expect-error an arbitrary of something that is not the machine's state
  loaded: otherArb,
});

// The rest of fast-check's settings reach the run.
const run: PropertyRun = propertyInvariant(machine, {}, seqArb, () => true, {
  numRuns: 10,
  seed: 1,
  path: "0:1",
  endOnFailure: true,
  interruptAfterTimeLimit: 100,
  markInterruptAsFailure: true,
});

// A check answers `boolean | string | null`, on both runners that take one. A plain
// boolean check, however it was declared, still compiles.
declare const answer: boolean | string | null;
const plainStep = (step: { readonly next: State }): boolean =>
  step.next.type === "done";
const plainTrace = (_steps: readonly unknown[], final: State): boolean =>
  final.type === "done";
propertyInvariant(machine, {}, seqArb, plainStep);
propertyInvariant(machine, {}, seqArb, () => answer);
propertyTrace(machine, {}, seqArb, plainTrace);
propertyTrace(machine, {}, seqArb, () => answer);
// @ts-expect-error a check answers no other type
propertyInvariant(machine, {}, seqArb, () => 1);
// @ts-expect-error a check answers no other type
propertyTrace(machine, {}, seqArb, () => undefined);
// @ts-expect-error `terminal` names states rather than laws, so it stays a boolean
propertyTerminates(machine, {}, seqArb, () => answer);

// One shape on both arms.
declare const failure: PropertyFailure;
const failed: PropertyRun = failure.run;

export const _witness = [run, failed, new PropertyFailure("report", run)];
