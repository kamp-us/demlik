/**
 * The replay how-to's compile-and-run gate (#542).
 *
 * `docs/how-to/replay-in-a-test.md` shows two ways to assert on a replayed
 * run, a windowed recording that still replays, and that recording kept in a
 * Durable Object store and read back to replay. Each is a `#region` of this file, verbatim (`../page-mirrors.ts` holds
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
import { downloader, type Msg, type State } from "../../../examples/downloader";
import { fakeDoStorage } from "../../__fixtures__/do-storage";
import { resilientFetch } from "../../../examples/resilient-fetch";

const ctx = { http: () => Promise.resolve("ok") };

// #region replay
import { replay } from "@demlik/tea";

const msgs: Msg[] = [
  { _tag: "start", total: 3 },
  { _tag: "chunk", size: 1 },
  { _tag: "chunk", size: 1 },
  { _tag: "chunk", size: 1 },
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
  { msgs: [{ _tag: "fetch", url: "/x", at: 1000 }], ctx },
  { _tag: "do_fetch", url: "/x" },
);
// #endregion assertions

// #region window
import { recorder, replayTrace } from "@demlik/tea/persistence";

const live = run(downloader, { terminal: (s) => s.phase === "done" });
const rec = recorder(live, { window: 2 });
await live.ready;
for (const msg of msgs) await live.dispatch(msg);

const trace = rec.dump();
expect(trace.msgs).toEqual(msgs.slice(2));
expect(trace.skipped).toBe(2);
expect(replayTrace(downloader, trace).matches).toBe(true);
// #endregion window
await live.stop();

const { storage } = fakeDoStorage();

// #region store
import { doEventLogReader, doEventSourcedStore } from "@demlik/tea/do";
import { writeTrace } from "@demlik/tea/persistence";

const kept = run(downloader, { terminal: (s) => s.phase === "done" });
const capture = recorder(kept, { captureSteps: true, window: 2 });
await kept.ready;
for (const msg of msgs) await kept.dispatch(msg);

const es = doEventSourcedStore(
  storage,
  downloader,
  {},
  {
    recording: { provenance: { test: "download" }, maxRowBytes: 1_000_000 },
  },
);
await writeTrace(es.store, capture.dump());

const back = await doEventLogReader(storage).readTrace<State>();
if (back._tag !== "trace") throw new Error(`unavailable: ${back.reason}`);
expect(back.trace.skipped).toBe(2);
expect(replayTrace(downloader, back.trace).matches).toBe(true);
// #endregion store
await kept.stop();
capture.stop();

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
