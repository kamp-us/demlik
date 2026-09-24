// Type-level test for resilient-call's `settle` (#271, #282). Compiled by
// `pnpm typecheck` (tsc over `src/**` includes `*.test-d.ts`). Every
// `@ts-expect-error` must sit on a line that genuinely fails to type-check.
//
// The contract:
//   1. `settle` takes the knob's own engine-minted `<name>_run_ok` or
//      `<name>_run_err` Msg and nothing else.
//   2. It returns `{ call, cmds, outcome }`, and `outcome` narrows on `kind`:
//      `value` exists only on `done`, `error` only on `failed`.
//   3. The knob carries no `succeed` / `fail` and no `handlers`.

import { createResilientCall, type ResilientState } from "./index";

const rc = createResilientCall<string, number, "job">({ name: "job" });
const slice: ResilientState<string, number> = rc.init();
const cmd = rc.run({ key: "k", input: "in" });

// 1 — both settle Msgs are accepted, as the engine mints them.
rc.settle(slice, rc.run.ok(cmd, 1, 0));
rc.settle(slice, rc.run.err(cmd, { _tag: "port_rejected", cause: "boom" }, 0));
rc.settle(slice, { type: "job_run_ok", cmd, value: 1, at: 0 });
rc.settle(slice, {
  type: "job_run_err",
  cmd,
  error: { _tag: "port_rejected" },
  at: 0,
});
// @ts-expect-error — another knob's Msg family is refused.
rc.settle(slice, { type: "resilient_run_ok", cmd, value: 1, at: 0 });

// 2 — the three fields, and the value only through `outcome`.
const r = rc.settle(slice, rc.run.ok(cmd, 1, 0));
const next: ResilientState<string, number> = r.call;
void next;
void r.cmds;
switch (r.outcome.kind) {
  case "done": {
    const value: number = r.outcome.value;
    void value;
    break;
  }
  case "failed": {
    const error: unknown = r.outcome.error;
    void error;
    // @ts-expect-error — a failed outcome carries no value.
    void r.outcome.value;
    break;
  }
  case "retrying":
    // @ts-expect-error — a retrying outcome carries neither value nor error.
    void r.outcome.error;
    break;
}
// @ts-expect-error — the value is not reachable without narrowing `outcome`.
void r.outcome.value;

// 3 — the old verbs and the handler splice are gone.
// @ts-expect-error — `succeed` is no longer on the knob.
void rc.succeed;
// @ts-expect-error — `fail` is no longer on the knob.
void rc.fail;
// @ts-expect-error — `handlers` is no longer on the knob (ADR 0021).
void rc.handlers;
