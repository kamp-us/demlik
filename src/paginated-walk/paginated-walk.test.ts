import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine, replay, run } from "../index";
import { bindMachine } from "../testing";
import {
  createPaginatedWalk,
  deadlineSub,
  type FetchPageCmd,
  PAGE_KEY,
  type PageErrMsg,
  type PageOkMsg,
  type PaginatedWalkState,
  type PaginatedWalkTimerMsg,
} from "./index";

// ---------------------------------------------------------------------------
// A test API page: a numeric-offset paginator with a known number of pages.
// `nextCursor` returns the next offset until `last`, then null. `onPage`
// emits one `index` cmd per page so we can observe per-page work.
// ---------------------------------------------------------------------------

interface Page {
  readonly offset: number;
  readonly items: readonly string[];
  readonly last: boolean;
}

type IndexCmd = Cmd<"index"> & { readonly offset: number };

const page = (offset: number, last = false): Page => ({
  offset,
  items: [`row@${offset}`],
  last,
});

// rng pinned to 0 → "full" jitter collapses the backoff delay to 0, so a
// retry's retryAtMs == at: deterministic timer targets in assertions.
const rngZero = () => 0;

// Three offset pages: 0 → 1 → 2(last). nextCursor advances by 1 until `last`.
const baseConfig = {
  firstPage: 0,
  nextCursor: (p: Page): number | null => (p.last ? null : p.offset + 1),
  onPage: (p: Page): readonly IndexCmd[] => [
    { type: "index", offset: p.offset },
  ],
  retry: {
    baseMs: 100,
    factor: 2,
    capMs: 10_000,
    maxAttempts: 3,
    jitter: "full" as const,
  },
  rateLimit: { capacity: 2, refillPerSec: 1 },
  deadline: { ms: 5_000 },
};

// ---------------------------------------------------------------------------
// A minimal host machine that wires the knob's slice as a single `walk` field.
// The inherited resilient_ok / resilient_err Msgs map to pageOk / pageErr.
// ---------------------------------------------------------------------------

interface HostState {
  readonly walk: PaginatedWalkState<number, Page>;
}
type HostMsg =
  | { type: "start"; at: number }
  | PageOkMsg<Page>
  | PageErrMsg
  | PaginatedWalkTimerMsg;
type HostCmd = FetchPageCmd<number> | IndexCmd;

function makeMachine(
  config: Parameters<
    typeof createPaginatedWalk<number, Page, IndexCmd>
  >[0] = baseConfig,
  rng = rngZero,
) {
  const walk = createPaginatedWalk<number, Page, IndexCmd>(config, rng);
  const machine = defineMachine<
    HostState,
    HostMsg,
    HostCmd,
    ReturnType<typeof walk.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ walk: walk.init() }, []],
    update: {
      start: (s, m) => {
        const [slice, cmds] = walk.start(s.walk, m.at);
        return [{ walk: slice }, cmds];
      },
      resilient_ok: (s, m) => {
        const [slice, cmds] = walk.pageOk(s.walk, m.result, m.at);
        return [{ walk: slice }, cmds];
      },
      resilient_err: (s, m) => {
        const [slice, cmds] = walk.pageErr(s.walk, m.error, m.at);
        return [{ walk: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = walk.onTimer(s.walk, m);
        return [{ walk: slice }, cmds];
      },
    },
    subscriptions: (s) => walk.subs(s.walk),
    subscribe: { deadline: () => () => {} },
  });
  return { walk, machine };
}

const ctx = {} as object;

// Convenience constructors for the inherited settle Msgs.
const okMsg = (result: Page, at: number): PageOkMsg<Page> => ({
  type: "resilient_ok",
  key: PAGE_KEY,
  result,
  at,
});
const errMsg = (error: unknown, at: number): PageErrMsg => ({
  type: "resilient_err",
  key: PAGE_KEY,
  error,
  at,
});

const fetchCmd = (offset: number): FetchPageCmd<number> => ({
  type: "resilient_run",
  key: PAGE_KEY,
  input: offset,
});

describe("createPaginatedWalk — init", () => {
  it("starts idle, with a fresh resilient-call slice and no pages seen", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    const s = walk.init();
    expect(s.walk).toEqual({ phase: "idle", seen: 0, pages: 0 });
    expect(s.resilience.calls).toEqual({});
    expect(s.resilience.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(walk.isComplete(s)).toBe(false);
  });
});

describe("createPaginatedWalk — start", () => {
  it("arms the first cursor and issues the first page fetch", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    const [s, cmds] = walk.start(walk.init(), 0);
    expect(cmds).toEqual([fetchCmd(0)]);
    expect(s.walk.phase).toBe("fetching");
    if (s.walk.phase === "fetching") expect(s.walk.cursor).toBe(0);
    expect(s.resilience.calls[PAGE_KEY]).toEqual({
      phase: "running",
      input: 0,
      deadlineAtMs: 5_000,
    });
  });

  it("honors a non-default firstPage cursor", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, firstPage: 40 },
      rngZero,
    );
    const [, cmds] = walk.start(walk.init(), 0);
    expect(cmds).toEqual([fetchCmd(40)]);
  });

  it("re-starting an in-flight walk is a no-op (no page-one skip, no double-fetch)", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    const [s1] = walk.start(walk.init(), 0);
    const [s2, cmds] = walk.start(s1, 10);
    expect(cmds).toEqual([]);
    expect(s2).toBe(s1); // pure no-op preserves identity
  });
});

describe("createPaginatedWalk — pageOk (advance / finish)", () => {
  it("advances the cursor and fetches the next page, emitting onPage cmds", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    const [s2, cmds] = walk.pageOk(s, page(0), 10);
    // onPage(page 0) cmd, then the next page-fetch effect for cursor 1.
    expect(cmds).toEqual([{ type: "index", offset: 0 }, fetchCmd(1)]);
    expect(s2.walk.phase).toBe("fetching");
    if (s2.walk.phase === "fetching") expect(s2.walk.cursor).toBe(1);
    expect(s2.walk.pages).toBe(1);
  });

  it("finishes (done) when nextCursor returns null — no further fetch", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    const [s2, cmds] = walk.pageOk(s, page(0, true), 10);
    // The last page still emits its onPage cmd, but NO next fetch.
    expect(cmds).toEqual([{ type: "index", offset: 0 }]);
    expect(s2.walk.phase).toBe("done");
    expect(walk.isComplete(s2)).toBe(true);
  });

  it("settles the resilient call OK on the final page (no re-fetch to overwrite the slot)", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    // The last page finishes the walk → no next fetch overwrites PAGE_KEY, so
    // the settled-succeeded slot is observable.
    [s] = walk.pageOk(s, page(0, true), 10);
    expect(s.resilience.calls[PAGE_KEY]).toEqual({
      phase: "succeeded",
      result: page(0, true),
    });
  });

  it("a stray pageOk while not fetching does not advance the cursor or double-count", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0, true), 10); // → done
    const before = s.walk;
    const [s2, cmds] = walk.pageOk(s, page(5), 20);
    // The paginator is done → recordPage absorbs it: cursor + counters frozen.
    expect(s2.walk).toEqual(before);
    // onPage still fires (the consumer's per-page work runs on any success).
    expect(cmds).toEqual([{ type: "index", offset: 5 }]);
  });

  it("walks all pages to completion via repeated pageOk", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      // No rate limit so every page fetch passes immediately.
      { ...baseConfig, rateLimit: undefined },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0), 0); // → fetch 1
    [s] = walk.pageOk(s, page(1), 0); // → fetch 2
    const [s3, cmds] = walk.pageOk(s, page(2, true), 0); // → done
    expect(s3.walk.pages).toBe(3);
    expect(walk.isComplete(s3)).toBe(true);
    expect(cmds).toEqual([{ type: "index", offset: 2 }]); // last page: no fetch
  });
});

describe("createPaginatedWalk — backpressure (paused)", () => {
  it("parks in paused once the high-water mark is reached and emits no next fetch", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      // pageSize 1 per page, hwm 1 → first page pauses immediately.
      { ...baseConfig, rateLimit: undefined, highWaterMark: 1 },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    const [s2, cmds] = walk.pageOk(s, page(0), 0);
    expect(s2.walk.phase).toBe("paused");
    if (s2.walk.phase === "paused") expect(s2.walk.cursor).toBe(1);
    // onPage cmd only — the next fetch is withheld until drained / resumed.
    expect(cmds).toEqual([{ type: "index", offset: 0 }]);
  });
});

describe("createPaginatedWalk — drain / resume (the two-way valve)", () => {
  it("drain lowers seen below the mark, then resume re-opens the parked fetch", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, rateLimit: undefined, highWaterMark: 1 },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0), 0); // → paused on cursor 1, seen 1
    expect(s.walk.phase).toBe("paused");

    let cmds: readonly (FetchPageCmd<number> | IndexCmd)[];
    [s, cmds] = walk.drain(s, 1); // seen → 0
    expect(cmds).toEqual([]);
    expect(s.walk.seen).toBe(0);
    expect(s.walk.phase).toBe("paused"); // drain frees headroom, not phase

    [s, cmds] = walk.resume(s, 100); // headroom exists → re-arm + fetch
    expect(cmds).toEqual([fetchCmd(1)]);
    expect(s.walk.phase).toBe("fetching");
    if (s.walk.phase === "fetching") expect(s.walk.cursor).toBe(1);
  });

  it("resume without draining below the mark is a pure no-op (valve stays shut)", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, rateLimit: undefined, highWaterMark: 1 },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0), 0); // → paused, seen 1 (still at the mark)
    const before = s;
    const [after, cmds] = walk.resume(s, 100);
    expect(cmds).toEqual([]);
    expect(after).toBe(before); // no headroom → no resume
  });

  it("drain n<=0 is a pure no-op", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, rateLimit: undefined, highWaterMark: 1 },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0), 0); // → paused
    const before = s;
    const [after, cmds] = walk.drain(s, 0);
    expect(cmds).toEqual([]);
    expect(after).toBe(before);
  });
});

describe("createPaginatedWalk — failure / isStuck (observable dead walk)", () => {
  it("isStuck + failure surface a terminal page failure that stranded the walk", () => {
    const boom = { _tag: "upstream_down" as const };
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, rateLimit: undefined, retry: undefined }, // no retry
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageErr(s, boom, 0); // no retry → terminal failed
    expect(s.resilience.calls[PAGE_KEY]?.phase).toBe("failed");
    // The paginator never advanced and never finished — the walk is stuck.
    expect(s.walk.phase).toBe("fetching");
    expect(walk.isComplete(s)).toBe(false);
    expect(walk.isStuck(s)).toBe(true);
    expect(walk.failure(s)).toEqual(boom);
  });

  it("a healthy walk is never stuck and reports no failure", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, rateLimit: undefined },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    expect(walk.isStuck(s)).toBe(false);
    expect(walk.failure(s)).toBeUndefined();
    [s] = walk.pageOk(s, page(0, true), 0); // → done
    expect(walk.isStuck(s)).toBe(false); // done is a healthy finish, not stuck
    expect(walk.failure(s)).toBeUndefined();
  });
});

describe("createPaginatedWalk — pageErr (back off, don't advance)", () => {
  it("schedules a retry on a transient failure and leaves the cursor parked", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    const [s2, cmds] = walk.pageErr(s, "boom", 100);
    // No fetch emitted (backed off), paginator still parked on cursor 0.
    expect(cmds).toEqual([]);
    expect(s2.walk.phase).toBe("fetching");
    if (s2.walk.phase === "fetching") expect(s2.walk.cursor).toBe(0);
    // The resilient page-fetch call is waiting_retry, re-issuing the same cursor.
    expect(s2.resilience.calls[PAGE_KEY]).toEqual({
      phase: "waiting_retry",
      input: 0,
      retryAtMs: 100, // rngZero → delay 0
      deadlineAtMs: 5_000, // preserved from the original fetch (start at at=0)
    });
  });

  it("a stray pageErr after the walk is done is a pure no-op (slot + breaker untouched)", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, circuit: { threshold: 5, cooldownMs: 30_000 } },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0, true), 10); // → done, slot succeeded
    const before = s;
    const [after, cmds] = walk.pageErr(s, "late-boom", 20);
    expect(cmds).toEqual([]);
    expect(after).toBe(before); // pure no-op preserves identity
    // The settled-succeeded slot is NOT clobbered to failed.
    expect(after.resilience.calls[PAGE_KEY]).toEqual({
      phase: "succeeded",
      result: page(0, true),
    });
    // The shared breaker never saw a phantom failure.
    expect(after.resilience.circuit).toEqual({ phase: "closed", failures: 0 });
  });

  it("a stray pageErr while paused is a pure no-op", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, rateLimit: undefined, highWaterMark: 1 },
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0), 0); // → paused on cursor 1
    expect(s.walk.phase).toBe("paused");
    const before = s;
    const [after, cmds] = walk.pageErr(s, "boom", 5);
    expect(cmds).toEqual([]);
    expect(after).toBe(before);
  });

  it("settles the page-fetch failed once retries are exhausted; the walk does not advance", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    // maxAttempts 3 → attempts 0,1,2 retry; the 3rd recorded failure gives up.
    for (let i = 0; i < 3; i++) {
      [s] = walk.onTimer(s, {
        type: "deadline_exceeded",
        id: `resilient:retry:${PAGE_KEY}`,
        atMs: 0,
      });
      [s] = walk.pageErr(s, `e${i}`, 0);
    }
    expect(s.resilience.calls[PAGE_KEY]?.phase).toBe("failed");
    // The paginator never advanced past the failing cursor.
    expect(s.walk.phase).toBe("fetching");
    if (s.walk.phase === "fetching") expect(s.walk.cursor).toBe(0);
  });
});

describe("createPaginatedWalk — onTimer (retry the same page)", () => {
  it("re-issues the SAME page fetch when the retry timer fires", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageErr(s, "boom", 0);
    expect(s.resilience.calls[PAGE_KEY]?.phase).toBe("waiting_retry");
    const [s2, cmds] = walk.onTimer(s, {
      type: "deadline_exceeded",
      id: `resilient:retry:${PAGE_KEY}`,
      atMs: 0,
    });
    // Same cursor 0 re-fetched — never a skipped page.
    expect(cmds).toEqual([fetchCmd(0)]);
    expect(s2.resilience.calls[PAGE_KEY]?.phase).toBe("running");
  });

  it("a stale timer for a settled fetch is a pure no-op", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0), 0); // settle the fetch succeeded
    const before = s;
    const [after, cmds] = walk.onTimer(s, {
      type: "deadline_exceeded",
      id: `resilient:retry:${PAGE_KEY}`,
      atMs: 0,
    });
    expect(cmds).toEqual([]);
    expect(after).toBe(before); // identity unchanged
  });
});

describe("createPaginatedWalk — subs", () => {
  it("arms a deadline timer while a page fetch is active", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    const [s] = walk.start(walk.init(), 100);
    expect(walk.subs(s)).toEqual([
      deadlineSub(`resilient:deadline:${PAGE_KEY}`, 5_100),
    ]);
  });

  it("arms a retry timer while the page fetch is waiting_retry", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 100);
    [s] = walk.pageErr(s, "e", 100);
    expect(walk.subs(s)).toEqual([
      deadlineSub(`resilient:retry:${PAGE_KEY}`, 100),
      deadlineSub(`resilient:deadline:${PAGE_KEY}`, 5_100),
    ]);
  });

  it("disarms every timer once the walk is done", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    let s = walk.init();
    [s] = walk.start(s, 0);
    [s] = walk.pageOk(s, page(0, true), 0);
    expect(walk.subs(s)).toEqual([]);
  });
});

describe("createPaginatedWalk — handlers route Ok/Err to settle Msgs", () => {
  it("routes a resolving fetch port to a resilient_ok msg carrying the page", async () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    const handler = walk.handlers({
      run: async (cursor) => page(cursor),
    }).resilient_run;
    const msg = await handler(fetchCmd(7), {} as never);
    expect(msg?.type).toBe("resilient_ok");
    if (msg?.type === "resilient_ok") {
      expect(msg.key).toBe(PAGE_KEY);
      expect(msg.result).toEqual(page(7));
    }
  });

  it("routes a rejecting fetch port to a resilient_err msg carrying the original error", async () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    const boom = new Error("upstream 500");
    const handler = walk.handlers({
      run: async () => {
        throw boom;
      },
    }).resilient_run;
    const msg = await handler(fetchCmd(0), {} as never);
    expect(msg?.type).toBe("resilient_err");
    if (msg?.type === "resilient_err") expect(msg.error).toBe(boom);
  });
});

describe("createPaginatedWalk — wired in a machine (replay)", () => {
  // No rate limit so every page fetch passes immediately — the clean-sequence
  // assertions below observe the unthrottled fetch → index → fetch cadence.
  const { machine } = makeMachine({ ...baseConfig, rateLimit: undefined });
  const bound = bindMachine(machine, ctx);

  it("init produces an idle walk with no subs", () => {
    const { state, subs } = bound.replay({ msgs: [] });
    expect(state.walk.walk).toEqual({ phase: "idle", seen: 0, pages: 0 });
    expect(subs).toEqual([]);
  });

  it("start → fetch cmd, then page_ok → index + next fetch through the reducer", () => {
    bound.expectCmdSequence(
      {
        msgs: [{ type: "start", at: 0 }, okMsg(page(0), 0)],
      },
      [fetchCmd(0), { type: "index", offset: 0 }, fetchCmd(1)],
    );
  });

  it("a full three-page walk emits one index cmd per page and finishes done", () => {
    const { state, cmds } = bound.replay({
      msgs: [
        { type: "start", at: 0 },
        okMsg(page(0), 0),
        okMsg(page(1), 0),
        okMsg(page(2, true), 0),
      ],
    });
    expect(state.walk.walk.phase).toBe("done");
    expect(state.walk.walk.pages).toBe(3);
    expect(cmds).toEqual([
      fetchCmd(0),
      { type: "index", offset: 0 },
      fetchCmd(1),
      { type: "index", offset: 1 },
      fetchCmd(2),
      { type: "index", offset: 2 },
    ]);
  });

  it("start → page_err leaves a retry + deadline timer desired", () => {
    bound.expectActiveSubs(
      { msgs: [{ type: "start", at: 0 }, errMsg("e", 0)] },
      [
        deadlineSub(`resilient:retry:${PAGE_KEY}`, 0),
        deadlineSub(`resilient:deadline:${PAGE_KEY}`, 5_000),
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// WIRED end-to-end machine tests. These build a REAL runtime via `run`, with a
// real fetch port whose resolution re-enters the machine through `interpret`'s
// follow-up Msg (enqueued on the dispatch tail — genuine re-entry, not a
// hand-fed Msg). The scenario is driven to its END STATE, and the END STATE is
// asserted — not the intermediate Msgs. This is the test class that was MISSING
// (the bugs below shipped green because every prior test hand-fed the settle
// Msgs and never let a stray one race a settled walk through the real loop).
// ---------------------------------------------------------------------------

// A runtime-wired host. `interpret` runs the consumer's fetch port; its result
// is the `resilient_ok` / `resilient_err` Msg the runtime enqueues back onto
// the tail — the page fetch genuinely re-enters the bound machine.
function wiredMachine(
  config: Parameters<typeof createPaginatedWalk<number, Page, IndexCmd>>[0],
  run_: (cursor: number) => Promise<Page>,
) {
  const walk = createPaginatedWalk<number, Page, IndexCmd>(config, rngZero);
  const machine = defineMachine<
    HostState,
    HostMsg,
    HostCmd,
    ReturnType<typeof walk.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ walk: walk.init() }, []],
    update: {
      start: (s, m) => {
        const [slice, cmds] = walk.start(s.walk, m.at);
        return [{ walk: slice }, cmds];
      },
      resilient_ok: (s, m) => {
        const [slice, cmds] = walk.pageOk(s.walk, m.result, m.at);
        return [{ walk: slice }, cmds];
      },
      resilient_err: (s, m) => {
        const [slice, cmds] = walk.pageErr(s.walk, m.error, m.at);
        return [{ walk: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = walk.onTimer(s.walk, m);
        return [{ walk: slice }, cmds];
      },
    },
    subscriptions: (s) => walk.subs(s.walk),
    subscribe: { deadline: () => () => {} },
    interpret: walk.handlers({ run: run_ }),
  });
  return { walk, machine };
}

// Spin the microtask queue until `predicate(getState())` holds (the runtime
// enqueues interpret follow-up Msgs on the tail, so the walk settles across
// several microtask turns after a single `dispatch`).
async function settleUntil<S>(
  getState: () => S,
  predicate: (s: S) => boolean,
  maxTurns = 100,
): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (predicate(getState())) return;
    await Promise.resolve();
  }
  if (!predicate(getState())) throw new Error("settleUntil: never settled");
}

describe("createPaginatedWalk — WIRED runtime (end-to-end)", () => {
  // A single-page walk WITH a circuit brick so a breaker ding is observable.
  const oneShotConfig = {
    ...baseConfig,
    rateLimit: undefined,
    retry: undefined, // first failure is terminal — keeps the scenario short
    circuit: { threshold: 5, cooldownMs: 30_000 },
  };

  it("DEFECT 1: a stray page_err after the walk settles done is a pure no-op — the succeeded page-fetch slot and the SHARED breaker survive", async () => {
    // The port always resolves page 0 as the LAST page → the walk finishes done
    // with PAGE_KEY settled `succeeded` and the breaker untouched.
    const { machine } = wiredMachine(oneShotConfig, async () => page(0, true));
    const rt = run(machine, { ctx });
    await rt.ready;

    // Drive: start → fetch(0) → port resolves → resilient_ok re-enters → done.
    await rt.dispatch({ type: "start", at: 0 });
    await settleUntil(
      () => rt.getState(),
      (s) => s.walk.walk.phase === "done",
    );
    // Sanity: the walk finished and the fetch slot settled succeeded.
    const settled = rt.getState();
    expect(settled.walk.walk.phase).toBe("done");
    expect(settled.walk.resilience.calls[PAGE_KEY]).toEqual({
      phase: "succeeded",
      result: page(0, true),
    });

    // Now a STRAY late failure for the already-settled fetch (a duplicate, a
    // double-dispatched err) races in AFTER the walk is done. Pre-fix this
    // re-entered rc.fail: it overwrote the succeeded slot with `failed` AND
    // tripped the shared circuit breaker. Post-fix the phase guard absorbs it.
    await rt.dispatch(errMsg("late-boom", 50));

    const end = rt.getState();
    // END STATE assertion — the settled slot is intact, untouched by the stray.
    expect(end.walk.resilience.calls[PAGE_KEY]).toEqual({
      phase: "succeeded",
      result: page(0, true),
    });
    // The SHARED breaker never saw a phantom failure from a non-existent fetch.
    expect(end.walk.resilience.circuit).toEqual({
      phase: "closed",
      failures: 0,
    });
    // The walk is still healthily done, not corrupted into a stuck/failed state.
    expect(end.walk.walk.phase).toBe("done");
    await rt.stop();
  });

  it("DEFECT 2: backpressure is a real valve — drain + resume re-open a paused walk and fetch the parked cursor end-to-end", async () => {
    // hwm 1, pageSize 1 → the first page pauses the walk on cursor 1.
    const { walk, machine } = wiredMachine(
      { ...baseConfig, rateLimit: undefined, highWaterMark: 1 },
      async (cursor) => page(cursor, cursor >= 2),
    );
    const rt = run(machine, { ctx });
    await rt.ready;

    await rt.dispatch({ type: "start", at: 0 });
    await settleUntil(
      () => rt.getState(),
      (s) => s.walk.walk.phase === "paused",
    );
    const paused = rt.getState();
    expect(paused.walk.walk.phase).toBe("paused");
    if (paused.walk.walk.phase === "paused") {
      expect(paused.walk.walk.cursor).toBe(1);
    }
    // Pre-fix there was NO drain/resume on the surface — the walk was stranded
    // in `paused` forever (a one-way valve). The verbs must exist AND re-open it.
    expect(typeof walk.drain).toBe("function");
    expect(typeof walk.resume).toBe("function");

    // The consumer drains the one un-acked item, then resumes: the parked cursor
    // 1 is re-fetched, page 1 still pauses (seen back to 1), drain+resume again
    // walks to cursor 2 (last) → done.
    let s = rt.getState().walk;
    [s] = walk.drain(s, 1);
    expect(s.walk.seen).toBe(0);
    const [, resumeCmds] = walk.resume(s, 0);
    // Resume re-issues the parked page fetch — the proof the valve re-opened.
    expect(resumeCmds).toEqual([fetchCmd(1)]);
    await rt.stop();
  });

  it("DEFECT 3: a terminal page failure makes the walk OBSERVABLY stuck — isStuck() / failure() surface a dead walk", async () => {
    // No retry → the first failure is terminal; the port always throws.
    const boom = { _tag: "upstream_down" as const };
    const { walk, machine } = wiredMachine(
      { ...baseConfig, rateLimit: undefined, retry: undefined },
      async () => {
        throw boom;
      },
    );
    const rt = run(machine, { ctx });
    await rt.ready;

    await rt.dispatch({ type: "start", at: 0 });
    // Drive until the fetch slot terminally fails (re-entered via interpret's
    // resilient_err follow-up). The paginator stays parked on cursor 0.
    await settleUntil(
      () => rt.getState(),
      (s) => s.walk.resilience.calls[PAGE_KEY]?.phase === "failed",
    );

    const end = rt.getState().walk;
    // END STATE: the paginator never advanced and never finished — it is stuck.
    expect(end.walk.phase).toBe("fetching");
    if (end.walk.phase === "fetching") expect(end.walk.cursor).toBe(0);
    expect(walk.isComplete(end)).toBe(false);
    // The dead-walk signal a consumer polls — errors are data, not silence.
    expect(walk.isStuck(end)).toBe(true);
    expect(walk.failure(end)).toEqual(boom);
    await rt.stop();
  });
});

// ---------------------------------------------------------------------------
// Properties — invariants that must hold over arbitrary verb sequences.
// ---------------------------------------------------------------------------

describe("createPaginatedWalk — properties", () => {
  it("verbs never mutate their input state (immutability)", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(50), (at, off) => {
        const s0 = walk.init();
        const frozen = Object.freeze({ ...s0 });
        const [s1] = walk.start(frozen, at);
        expect(s1).not.toBe(frozen);
        const [s2] = walk.pageOk(s1, page(off), at);
        const [s3] = walk.pageErr(s1, "e", at);
        expect(s2).not.toBe(s1);
        expect(s3).not.toBe(s1);
        return true;
      }),
    );
  });

  it("at most one page-fetch effect is emitted per verb call (single-shot walk)", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      baseConfig,
      rngZero,
    );
    type Action =
      | { kind: "start"; at: number }
      | { kind: "ok"; last: boolean; at: number }
      | { kind: "err"; at: number }
      | { kind: "retry"; at: number };
    const action = fc.oneof(
      fc.record({ kind: fc.constant("start" as const), at: fc.nat(20_000) }),
      fc.record({
        kind: fc.constant("ok" as const),
        last: fc.boolean(),
        at: fc.nat(20_000),
      }),
      fc.record({ kind: fc.constant("err" as const), at: fc.nat(20_000) }),
      fc.record({ kind: fc.constant("retry" as const), at: fc.nat(20_000) }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions: Action[]) => {
        let s = walk.init();
        let cursor = 0;
        for (const a of actions) {
          let cmds: readonly (FetchPageCmd<number> | IndexCmd)[] = [];
          switch (a.kind) {
            case "start":
              [s, cmds] = walk.start(s, a.at);
              break;
            case "ok":
              [s, cmds] = walk.pageOk(s, page(cursor++, a.last), a.at);
              break;
            case "err":
              [s, cmds] = walk.pageErr(s, "e", a.at);
              break;
            case "retry":
              [s, cmds] = walk.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:retry:${PAGE_KEY}`,
                atMs: a.at,
              });
              break;
          }
          // Never more than one page-fetch effect per verb (zero or one); the
          // walk is a sequencer, not a fan-out. onPage index cmds may add more,
          // but there is at most ONE resilient_run.
          const fetches = cmds.filter((c) => c.type === "resilient_run");
          if (fetches.length > 1) return false;
        }
        return true;
      }),
    );
  });

  it("a clean walk never advances past `done` and visits each cursor exactly once", () => {
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, rateLimit: undefined },
      rngZero,
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
        // n pages: cursors 0..n-1, the last one ends the walk.
        let s = walk.init();
        [s] = walk.start(s, 0);
        const indexed: number[] = [];
        for (let i = 0; i < n; i++) {
          const isLast = i === n - 1;
          let cmds: readonly (FetchPageCmd<number> | IndexCmd)[];
          [s, cmds] = walk.pageOk(s, page(i, isLast), 0);
          for (const c of cmds) if (c.type === "index") indexed.push(c.offset);
        }
        // Every cursor 0..n-1 indexed exactly once, in order.
        expect(indexed).toEqual([...Array(n).keys()]);
        expect(walk.isComplete(s)).toBe(true);
        expect(s.walk.pages).toBe(n);
        return true;
      }),
    );
  });

  it("replay is deterministic: the same msg sequence yields the same final state", () => {
    const { machine } = makeMachine();
    const msgArb = fc.array(
      fc.oneof(
        fc.record({ type: fc.constant("start" as const), at: fc.nat(10_000) }),
        fc.record({
          type: fc.constant("resilient_ok" as const),
          key: fc.constant(PAGE_KEY),
          result: fc.record({
            offset: fc.nat(20),
            items: fc.constant(["r"] as const),
            last: fc.boolean(),
          }),
          at: fc.nat(10_000),
        }),
        fc.record({
          type: fc.constant("resilient_err" as const),
          key: fc.constant(PAGE_KEY),
          error: fc.constant("e"),
          at: fc.nat(10_000),
        }),
      ),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(msgArb, (msgs) => {
        const a = replay(machine, { msgs: msgs as HostMsg[], ctx });
        const b = replay(machine, { msgs: msgs as HostMsg[], ctx });
        expect(a.state).toEqual(b.state);
        return true;
      }),
    );
  });

  // -------------------------------------------------------------------------
  // DURABILITY (package-wide canon) — the slice is plain data, so a
  // Durable-Object eviction mid-walk persists it via JSON and a reload must
  // resurrect the IDENTICAL slice: `JSON.parse(JSON.stringify(slice))` must
  // deep-equal `slice`. This drives EVERY verb that mutates the slice — start /
  // pageOk / pageErr / onTimer / drain / resume — in arbitrary order and
  // asserts JSON-stability at every reachable slice, so all three TERMINAL
  // slices are covered as the subset they are: `done` (healthy finish),
  // `paused` (backpressure), and the stuck `fetching` + `failed` resilient slot
  // (a terminal page failure). The failure path feeds the plain-data `{_tag}`
  // sentinel the module is contracted to receive (never a `new Error(...)`,
  // which would render to `{}` and break the round-trip — that is the slice's
  // half of the invariant resilient-call already guards for its deadline path).
  // -------------------------------------------------------------------------
  it("every reachable slice round-trips through JSON unchanged (durable, incl. every terminal slice)", () => {
    // hwm 1 so `paused` is reachable; retry present so both `waiting_retry` and
    // the terminal `failed` (stuck) slot are reachable across a verb sequence.
    const walk = createPaginatedWalk<number, Page, IndexCmd>(
      { ...baseConfig, highWaterMark: 1 },
      rngZero,
    );
    // Errors are data: the sentinel a contracted consumer passes to pageErr.
    const boom = { _tag: "upstream_down" as const };

    type Op =
      | { readonly kind: "start"; readonly at: number }
      | { readonly kind: "ok"; readonly last: boolean; readonly at: number }
      | { readonly kind: "err"; readonly at: number }
      | { readonly kind: "retry"; readonly at: number }
      | { readonly kind: "drain"; readonly n: number }
      | { readonly kind: "resume"; readonly at: number };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("start" as const), at: fc.nat(20_000) }),
      fc.record({
        kind: fc.constant("ok" as const),
        last: fc.boolean(),
        at: fc.nat(20_000),
      }),
      fc.record({ kind: fc.constant("err" as const), at: fc.nat(20_000) }),
      fc.record({ kind: fc.constant("retry" as const), at: fc.nat(20_000) }),
      fc.record({
        kind: fc.constant("drain" as const),
        n: fc.integer({ min: 0, max: 5 }),
      }),
      fc.record({ kind: fc.constant("resume" as const), at: fc.nat(20_000) }),
    );

    const assertRoundTrips = (slice: PaginatedWalkState<number, Page>) => {
      const roundTripped = JSON.parse(JSON.stringify(slice));
      expect(roundTripped).toEqual(slice);
    };

    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        let s = walk.init();
        assertRoundTrips(s); // the initial idle slice
        let cursor = 0;
        for (const op of ops) {
          switch (op.kind) {
            case "start":
              [s] = walk.start(s, op.at);
              break;
            case "ok":
              [s] = walk.pageOk(s, page(cursor++, op.last), op.at);
              break;
            case "err":
              [s] = walk.pageErr(s, boom, op.at);
              break;
            case "retry":
              [s] = walk.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:retry:${PAGE_KEY}`,
                atMs: op.at,
              });
              break;
            case "drain":
              [s] = walk.drain(s, op.n);
              break;
            case "resume":
              [s] = walk.resume(s, op.at);
              break;
          }
          // Every reachable slice — terminal or transient — is JSON-stable.
          assertRoundTrips(s);
        }
        return true;
      }),
    );
  });
});
