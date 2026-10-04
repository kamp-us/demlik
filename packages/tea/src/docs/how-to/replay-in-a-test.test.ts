/**
 * The replay how-to's compile-and-run gate (#542).
 *
 * `docs/how-to/replay-in-a-test.md` shows two ways to assert on a replayed
 * run. Each is a `#region` of this file, verbatim (`../page-mirrors.ts` holds
 * the row), so the page shows code the test program compiles. The regions sit
 * at module level, so the assertions they make run when this file loads, and
 * the test below checks the claim they rest on: a live run folds to the state
 * `replay` reconstructs.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the row this file backs.

import { run } from "@demlik/tea/promise";
import { describe, expect, it } from "vitest";
import { downloader, type Msg } from "../../../examples/downloader";
import { resilientFetch } from "../../../examples/resilient-fetch";

const ctx = { http: () => Promise.resolve("ok") };

// #region replay
import { replay } from "@demlik/tea";

const msgs: Msg[] = [
  { type: "start", total: 3 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
];

const { state, cmds } = replay(downloader, { msgs, ctx: undefined });

expect(state.phase).toBe("done");
expect(cmds).toEqual([]); // this machine emits no effects
// #endregion replay

// #region assertions
import { expectCmdEmitted, expectFinalState } from "@demlik/tea/testing";

expectFinalState(
  downloader,
  { msgs, ctx: undefined },
  { phase: "done", received: 3, total: 3 },
);

expectCmdEmitted(
  resilientFetch,
  { msgs: [{ type: "fetch", url: "/x", at: 1000 }], ctx },
  { type: "do_fetch", url: "/x" },
);
// #endregion assertions

describe("docs/how-to/replay-in-a-test.md — it runs", () => {
  it("a live run folds to the state `replay` reconstructs", async () => {
    const runtime = await run(downloader, {
      terminal: (s) => s.phase === "done",
    }).ready;
    for (const msg of msgs) await runtime.dispatch(msg);
    const live = await runtime.done();
    await runtime.stop();

    expect(live).toEqual(state);
    expectFinalState(downloader, { msgs, ctx: undefined }, live);
  });
});
