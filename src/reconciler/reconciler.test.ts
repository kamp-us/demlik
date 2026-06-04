import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine, replay } from "../index";
import { PAGE_KEY, type PageErrMsg, type PageOkMsg } from "../paginated-walk";
import { bindMachine } from "../testing";
import {
  createReconciler,
  deadlineSub,
  type ReconcilerState,
  type ReconcilerTimerMsg,
  type ScanPageCmd,
} from "./index";

// ---------------------------------------------------------------------------
// A fleet-sync reconcile: the ACTUAL world is a paginated list of nodes, each
// carrying its current config `version`. The DESIRED spec is a target version
// for a known set of node ids. `diff` produces one `upgrade` Change per node
// whose actual version lags the desired one. `apply(change)` emits the Cmd that
// upgrades a node; `applied` confirms it.
// ---------------------------------------------------------------------------

interface Node {
  readonly id: string;
  readonly version: number;
}

interface Page {
  readonly offset: number;
  readonly nodes: readonly Node[];
  readonly last: boolean;
}

interface Desired {
  /** Target version every node should converge to. */
  readonly version: number;
  /** The node ids the spec governs. */
  readonly ids: readonly string[];
}

interface Change {
  readonly nodeId: string;
  readonly to: number;
}

type ApplyCmd = Cmd<"apply_change"> & { readonly change: Change };

// rng pinned to 0 → "full" jitter collapses the scan-retry delay to 0, so a
// retry's retryAtMs == at: deterministic timer targets in assertions.
const rngZero = () => 0;

// Recursively freeze the WHOLE reachable graph of a slice (the slice record AND
// its nested `walk` sub-slice, `actual` / `plan` arrays, and `applied` cache
// entries). A shallow Object.freeze locks only the top-level record and lets a
// nested splice / property write slip through; deep-freezing makes any nested
// mutation throw in strict mode, so the "verbs never mutate" property actually
// guards the nested fields rather than just the top record.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

const node = (id: string, version: number): Node => ({ id, version });

// One page per offset; `nodes` carries that page's actual nodes. nextCursor
// advances offset by 1 until `last`.
const page = (offset: number, nodes: readonly Node[], last = false): Page => ({
  offset,
  nodes,
  last,
});

const desired: Desired = {
  version: 2,
  ids: ["a", "b", "c"],
};

// diff: for each desired id, if the actual node lags (or is missing), plan an
// upgrade to the target version. Stable order follows `desired.ids`.
const diff = (d: Desired, actual: readonly Node[]): readonly Change[] => {
  const byId = new Map(actual.map((n) => [n.id, n.version] as const));
  const changes: Change[] = [];
  for (const id of d.ids) {
    const current = byId.get(id) ?? 0;
    if (current < d.version) changes.push({ nodeId: id, to: d.version });
  }
  return changes;
};

const baseConfig = {
  desired,
  diff,
  apply: (change: Change): ApplyCmd => ({ type: "apply_change", change }),
  idOf: (change: Change): string => change.nodeId,
  firstPage: 0,
  nextCursor: (p: Page): number | null => (p.last ? null : p.offset + 1),
  itemsOf: (p: Page): readonly Node[] => p.nodes,
  retry: {
    baseMs: 100,
    factor: 2,
    capMs: 10_000,
    maxAttempts: 3,
    jitter: "full" as const,
  },
  rateLimit: { capacity: 5, refillPerSec: 1 },
  deadline: { ms: 5_000 },
};

type Rec = ReturnType<
  typeof createReconciler<Node, Desired, Page, Change, ApplyCmd, number>
>;

const make = (
  config: Parameters<
    typeof createReconciler<Node, Desired, Page, Change, ApplyCmd, number>
  >[0] = baseConfig,
  rng = rngZero,
): Rec =>
  createReconciler<Node, Desired, Page, Change, ApplyCmd, number>(config, rng);

// Convenience constructors for the inherited scan settle Msgs.
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
const fetchCmd = (offset: number): ScanPageCmd<number> => ({
  type: "resilient_run",
  key: PAGE_KEY,
  input: offset,
});
const applyCmd = (nodeId: string, to: number): ApplyCmd => ({
  type: "apply_change",
  change: { nodeId, to },
});

// ===========================================================================
// init
// ===========================================================================

describe("createReconciler — init", () => {
  it("starts idle with a fresh scan walk, empty actual / plan / ledger", () => {
    const rec = make();
    const s = rec.init();
    expect(s.phase).toBe("idle");
    expect(s.actual).toEqual([]);
    expect(s.plan).toEqual([]);
    expect(s.appliedCursor).toBe(0);
    expect(s.applied.entries).toEqual({});
    expect(s.walk.walk).toEqual({ phase: "idle", seen: 0, pages: 0 });
    expect(rec.isComplete(s)).toBe(false);
  });
});

// ===========================================================================
// scan
// ===========================================================================

describe("createReconciler — scan", () => {
  it("enters scanning and issues the first actual-list page fetch", () => {
    const rec = make();
    const [s, cmds] = rec.scan(rec.init(), 0);
    expect(s.phase).toBe("scanning");
    expect(cmds).toEqual([fetchCmd(0)]);
    expect(s.walk.walk.phase).toBe("fetching");
  });

  it("re-scanning an in-flight reconcile is a pure no-op (no double-scan)", () => {
    const rec = make();
    const [s1] = rec.scan(rec.init(), 0);
    const [s2, cmds] = rec.scan(s1, 10);
    expect(cmds).toEqual([]);
    expect(s2).toBe(s1);
  });
});

// ===========================================================================
// pageOk — accumulate actual, advance scan, plan on completion
// ===========================================================================

describe("createReconciler — pageOk (accumulate + advance)", () => {
  it("appends the page's items to actual and fetches the next page", () => {
    const rec = make();
    let s = rec.init();
    [s] = rec.scan(s, 0);
    const [s2, cmds] = rec.pageOk(s, page(0, [node("a", 1)]), 10);
    expect(s2.actual).toEqual([node("a", 1)]);
    expect(s2.phase).toBe("scanning");
    // Next scan page fetched (offset 1).
    expect(cmds).toEqual([fetchCmd(1)]);
  });

  it("accumulates across pages and preserves order", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    [s] = rec.pageOk(s, page(0, [node("a", 1)]), 0);
    [s] = rec.pageOk(s, page(1, [node("b", 2), node("c", 0)]), 0);
    expect(s.actual).toEqual([node("a", 1), node("b", 2), node("c", 0)]);
  });
});

// ===========================================================================
// plan-on-scan-complete — the scan→diff→apply hand-off
// ===========================================================================

describe("createReconciler — plan on scan completion", () => {
  it("computes the plan when the last page lands and emits the first apply", () => {
    // Single page, last → scan completes immediately. a@1 and c@0 lag desired 2;
    // b@2 is already at target. Plan = upgrade a, upgrade c (desired.ids order).
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    const [s2, cmds] = rec.pageOk(
      s,
      page(0, [node("a", 1), node("b", 2), node("c", 0)], true),
      10,
    );
    expect(s2.phase).toBe("applying");
    expect(s2.plan).toEqual([
      { nodeId: "a", to: 2 },
      { nodeId: "c", to: 2 },
    ]);
    // Exactly the first apply Cmd — the loop is sequential.
    expect(cmds).toEqual([applyCmd("a", 2)]);
    expect(s2.appliedCursor).toBe(0);
  });

  it("settles done immediately when the actual world already matches desired (empty plan)", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    const [s2, cmds] = rec.pageOk(
      s,
      page(0, [node("a", 2), node("b", 2), node("c", 2)], true),
      10,
    );
    expect(s2.phase).toBe("done");
    expect(s2.plan).toEqual([]);
    expect(cmds).toEqual([]);
    expect(rec.isComplete(s2)).toBe(true);
  });
});

// ===========================================================================
// applyNext / applied — the sequential apply loop
// ===========================================================================

describe("createReconciler — apply loop", () => {
  it("applies each change in order, one at a time, then settles done", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    let cmds: readonly Cmd[];
    // b@2 is already at target (not planned); a@1 and c@0 lag → plan [a, c].
    [s, cmds] = rec.pageOk(
      s,
      page(0, [node("a", 1), node("b", 2), node("c", 0)], true),
      0,
    );
    expect(cmds).toEqual([applyCmd("a", 2)]); // first change

    // Confirm a → next apply is c.
    [s, cmds] = rec.applied(s, { nodeId: "a", to: 2 }, 0);
    expect(cmds).toEqual([applyCmd("c", 2)]);
    expect(s.appliedCursor).toBe(1);

    // Confirm c → no more changes → done.
    [s, cmds] = rec.applied(s, { nodeId: "c", to: 2 }, 0);
    expect(cmds).toEqual([]);
    expect(s.phase).toBe("done");
    expect(rec.isComplete(s)).toBe(true);
    expect(s.appliedCursor).toBe(2);
  });

  it("records applied changes in the ledger keyed by idOf", () => {
    // Only `a` lags (b, c already at target) → single-change plan.
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    [s] = rec.pageOk(
      s,
      page(0, [node("a", 1), node("b", 2), node("c", 2)], true),
      0,
    );
    [s] = rec.applied(s, { nodeId: "a", to: 2 }, 0);
    expect(s.applied.entries.a?.value).toEqual({ nodeId: "a", to: 2 });
  });

  it("a late applied after done is a pure no-op", () => {
    // Only `a` lags → one change → confirming it settles done.
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    [s] = rec.pageOk(
      s,
      page(0, [node("a", 1), node("b", 2), node("c", 2)], true),
      0,
    );
    [s] = rec.applied(s, { nodeId: "a", to: 2 }, 0); // → done
    const before = s;
    const [after, cmds] = rec.applied(s, { nodeId: "a", to: 2 }, 0);
    expect(after).toBe(before);
    expect(cmds).toEqual([]);
  });
});

// ===========================================================================
// idempotent re-apply — the applied-ledger skip on resume
// ===========================================================================

describe("createReconciler — idempotent re-apply (eviction resume)", () => {
  it("applyNext skips changes already in the ledger and resumes at the first un-applied one", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    // Plan: a, c (both lag; b@2 already at target → not planned).
    [s] = rec.pageOk(
      s,
      page(0, [node("a", 1), node("b", 2), node("c", 0)], true),
      0,
    );
    // Apply a.
    [s] = rec.applied(s, { nodeId: "a", to: 2 }, 0);
    expect(s.appliedCursor).toBe(1);

    // Simulate an eviction-resume: rewind the cursor to 0 but keep the ledger.
    // applyNext must SKIP `a` (already in the ledger) and re-emit only `c`.
    const resumed: ReconcilerState<Node, Change, Page> = {
      ...s,
      appliedCursor: 0,
    };
    const [s2, cmds] = rec.applyNext(resumed, 0);
    expect(cmds).toEqual([applyCmd("c", 2)]);
    // Cursor advanced past the skipped `a` to park on `c` (index 1).
    expect(s2.appliedCursor).toBe(1);
  });

  it("a fully-applied plan re-run from cursor 0 emits nothing and settles done", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    [s] = rec.pageOk(
      s,
      page(0, [node("a", 1), node("b", 2), node("c", 0)], true),
      0,
    );
    [s] = rec.applied(s, { nodeId: "a", to: 2 }, 0);
    [s] = rec.applied(s, { nodeId: "c", to: 2 }, 0); // done, both in ledger
    const resumed: ReconcilerState<Node, Change, Page> = {
      ...s,
      phase: "applying",
      appliedCursor: 0,
    };
    const [s2, cmds] = rec.applyNext(resumed, 0);
    expect(cmds).toEqual([]);
    expect(s2.phase).toBe("done");
  });
});

// ===========================================================================
// planned — explicit plan installation / re-plan
// ===========================================================================

describe("createReconciler — planned (explicit)", () => {
  it("installs a caller-supplied plan and starts applying it", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    const supplied: readonly Change[] = [{ nodeId: "z", to: 9 }];
    const [s, cmds] = rec.planned(rec.init(), 0, supplied);
    expect(s.phase).toBe("applying");
    expect(s.plan).toEqual(supplied);
    expect(cmds).toEqual([applyCmd("z", 9)]);
  });

  it("diffs the slice's accumulated actual against desired when no plan is supplied", () => {
    const rec = make();
    const seeded: ReconcilerState<Node, Change, Page> = {
      ...rec.init(),
      actual: [node("a", 1)],
    };
    const [s, cmds] = rec.planned(seeded, 0);
    expect(s.plan).toEqual([
      { nodeId: "a", to: 2 },
      { nodeId: "b", to: 2 }, // missing → treated as version 0 < 2
      { nodeId: "c", to: 2 },
    ]);
    expect(cmds).toEqual([applyCmd("a", 2)]);
  });
});

// ===========================================================================
// pageErr / onTimer — scan resilience
// ===========================================================================

describe("createReconciler — scan resilience", () => {
  it("backs off a transient scan failure and stays scanning (cursor parked)", () => {
    const rec = make();
    let s = rec.init();
    [s] = rec.scan(s, 0);
    const [s2, cmds] = rec.pageErr(s, "boom", 100);
    expect(cmds).toEqual([]); // backed off
    expect(s2.phase).toBe("scanning");
    expect(s2.walk.resilience.calls[PAGE_KEY]).toEqual({
      phase: "waiting_retry",
      input: 0,
      retryAtMs: 100, // rngZero → delay 0
      deadlineAtMs: 5_000,
    });
  });

  it("re-issues the SAME scan page when the retry timer fires", () => {
    const rec = make();
    let s = rec.init();
    [s] = rec.scan(s, 0);
    [s] = rec.pageErr(s, "boom", 0);
    const [s2, cmds] = rec.onTimer(s, {
      type: "deadline_exceeded",
      id: `resilient:retry:${PAGE_KEY}`,
      atMs: 0,
    });
    expect(cmds).toEqual([fetchCmd(0)]); // same cursor 0
    expect(s2.walk.resilience.calls[PAGE_KEY]?.phase).toBe("running");
  });

  it("escalates to failed once the scan's page-fetch retries are exhausted", () => {
    const rec = make();
    let s = rec.init();
    [s] = rec.scan(s, 0);
    // maxAttempts 3 → attempts 0,1,2 retry; the 3rd recorded failure gives up.
    for (let i = 0; i < 3; i++) {
      [s] = rec.onTimer(s, {
        type: "deadline_exceeded",
        id: `resilient:retry:${PAGE_KEY}`,
        atMs: 0,
      });
      [s] = rec.pageErr(s, `e${i}`, 0);
    }
    expect(s.walk.resilience.calls[PAGE_KEY]?.phase).toBe("failed");
    expect(s.phase).toBe("failed");
    expect(rec.isComplete(s)).toBe(false);
  });

  it("a stale scan timer is a pure no-op", () => {
    const rec = make();
    let s = rec.init();
    [s] = rec.scan(s, 0);
    [s] = rec.pageOk(s, page(0, [node("a", 1)], true), 0); // scan done → applying
    const before = s;
    const [after, cmds] = rec.onTimer(s, {
      type: "deadline_exceeded",
      id: `resilient:retry:${PAGE_KEY}`,
      atMs: 0,
    });
    expect(after).toBe(before);
    expect(cmds).toEqual([]);
  });
});

// ===========================================================================
// subs — the scan's timers, gone once the scan finishes
// ===========================================================================

describe("createReconciler — subs", () => {
  it("arms a scan deadline timer while a scan page is in flight", () => {
    const rec = make();
    const [s] = rec.scan(rec.init(), 100);
    expect(rec.subs(s)).toEqual([
      deadlineSub(`resilient:deadline:${PAGE_KEY}`, 5_100),
    ]);
  });

  it("desires no subs once scanning finishes and the apply loop is running", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    let s = rec.init();
    [s] = rec.scan(s, 0);
    [s] = rec.pageOk(s, page(0, [node("a", 1)], true), 0); // → applying
    expect(rec.subs(s)).toEqual([]);
  });
});

// ===========================================================================
// handlers — the scan port routes Ok/Err to settle Msgs
// ===========================================================================

describe("createReconciler — handlers route scan Ok/Err", () => {
  it("routes a resolving actual-list fetch to a resilient_ok msg carrying the page", async () => {
    const rec = make();
    const p = page(3, [node("x", 1)]);
    const handler = rec.handlers({ run: async () => p }).resilient_run;
    const msg = await handler(fetchCmd(3), {} as never);
    expect(msg?.type).toBe("resilient_ok");
    if (msg?.type === "resilient_ok") expect(msg.result).toEqual(p);
  });

  it("routes a rejecting fetch to a resilient_err msg carrying the original error", async () => {
    const rec = make();
    const boom = new Error("list 500");
    const handler = rec.handlers({
      run: async () => {
        throw boom;
      },
    }).resilient_run;
    const msg = await handler(fetchCmd(0), {} as never);
    expect(msg?.type).toBe("resilient_err");
    if (msg?.type === "resilient_err") expect(msg.error).toBe(boom);
  });
});

// ===========================================================================
// wired in a machine (replay) — end-to-end through the reducer
// ===========================================================================

interface HostState {
  readonly rec: ReconcilerState<Node, Change, Page>;
}
type HostMsg =
  | { type: "reconcile"; at: number }
  | PageOkMsg<Page>
  | PageErrMsg
  | { type: "change_done"; change: Change; at: number }
  | ReconcilerTimerMsg;
type HostCmd = ScanPageCmd<number> | ApplyCmd;

function makeMachine(
  config: Parameters<
    typeof createReconciler<Node, Desired, Page, Change, ApplyCmd, number>
  >[0] = { ...baseConfig, rateLimit: undefined },
) {
  const rec = make(config);
  const machine = defineMachine<
    HostState,
    HostMsg,
    HostCmd,
    ReturnType<typeof rec.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ rec: rec.init() }, []],
    update: {
      reconcile: (s, m) => {
        const [slice, cmds] = rec.scan(s.rec, m.at);
        return [{ rec: slice }, cmds];
      },
      resilient_ok: (s, m) => {
        const [slice, cmds] = rec.pageOk(s.rec, m.result, m.at);
        return [{ rec: slice }, cmds];
      },
      resilient_err: (s, m) => {
        const [slice, cmds] = rec.pageErr(s.rec, m.error, m.at);
        return [{ rec: slice }, cmds];
      },
      change_done: (s, m) => {
        const [slice, cmds] = rec.applied(s.rec, m.change, m.at);
        return [{ rec: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = rec.onTimer(s.rec, m);
        return [{ rec: slice }, cmds];
      },
    },
    subscriptions: (s) => rec.subs(s.rec),
    subscribe: { deadline: () => () => {} },
  });
  return { rec, machine };
}

const ctx = {} as object;

describe("createReconciler — wired in a machine (replay)", () => {
  const { machine } = makeMachine();
  const bound = bindMachine(machine, ctx);

  it("init produces an idle reconcile with no subs", () => {
    const { state, subs } = bound.replay({ msgs: [] });
    expect(state.rec.phase).toBe("idle");
    expect(subs).toEqual([]);
  });

  it("reconcile → scan; one-page scan → plan → first apply through the reducer", () => {
    bound.expectCmdSequence(
      {
        msgs: [
          { type: "reconcile", at: 0 },
          okMsg(page(0, [node("a", 1), node("c", 0)], true), 0),
        ],
      },
      [fetchCmd(0), applyCmd("a", 2)],
    );
  });

  it("a full reconcile: scan two pages, plan, apply each change, finish done", () => {
    const { state, cmds } = bound.replay({
      msgs: [
        { type: "reconcile", at: 0 },
        okMsg(page(0, [node("a", 1)], false), 0),
        okMsg(page(1, [node("b", 2), node("c", 0)], true), 0),
        { type: "change_done", change: { nodeId: "a", to: 2 }, at: 0 },
        { type: "change_done", change: { nodeId: "c", to: 2 }, at: 0 },
      ],
    });
    expect(state.rec.phase).toBe("done");
    // a@1 lags, b@2 at target, c@0 lags → plan [a, c].
    expect(cmds).toEqual([
      fetchCmd(0),
      fetchCmd(1),
      applyCmd("a", 2),
      applyCmd("c", 2),
    ]);
  });

  it("reconcile → scan err leaves a retry + deadline timer desired", () => {
    bound.expectActiveSubs(
      { msgs: [{ type: "reconcile", at: 0 }, errMsg("e", 0)] },
      [
        deadlineSub(`resilient:retry:${PAGE_KEY}`, 0),
        deadlineSub(`resilient:deadline:${PAGE_KEY}`, 5_000),
      ],
    );
  });
});

// ===========================================================================
// WIRED re-plan regression — the DEFAULT idOf must key by change IDENTITY, not
// plan POSITION. This is the systemic end-to-end test the bug shipped without:
// a real machine, driven through replay, asserting the END STATE after a
// re-plan — never the intermediate hand-fed Msgs.
//
// The machine uses the DEFAULT idOf (no `idOf` in config), so the ledger key is
// whatever `createReconciler` defaults to. The host's `re_plan` cell routes to
// `rec.planned(state, at, changes)` — the documented "re-plan after a desired
// change" path. The `change_done` re-enters via `rec.applied`.
//
// Scenario:
//   1. scan one page → node `a@1` lags desired 2, `b@2` & `c@2` at target
//      → plan = [ {a→2} ] (a single change, sitting at plan index 0).
//   2. apply + confirm a → its ledger entry is written under a's id.
//   3. a DESIRED change lands → re_plan installs a brand-new plan
//      [ {b→3} ] — `b` is a DIFFERENT, never-applied change that now also
//      sits at plan index 0.
//
// With a POSITION-keyed default idOf the `"0"` ledger entry from step 2 matches
// `b` in step 3 → the apply loop SKIPS b and settles `done` having emitted NO
// apply for b: the re-plan silently drops the change. With a CHANGE-IDENTITY
// default, b's id differs from a's → b is correctly applied. The END STATE
// (`applyCmd("b", 3)` emitted, b in the ledger) is the assertion — fed Msgs are
// never asserted directly.
// ===========================================================================

type RePlanHostMsg =
  | HostMsg
  | { type: "re_plan"; at: number; changes: readonly Change[] };

function makeRePlanMachine() {
  // NOTE: NO `idOf` — exercises the DEFAULT change-id. Position-keyed default
  // fails this test; identity-keyed (change-content) default passes.
  const { idOf: _idOf, ...noIdOf } = baseConfig;
  void _idOf;
  const rec = make({ ...noIdOf, rateLimit: undefined } as typeof baseConfig);
  const machine = defineMachine<
    HostState,
    RePlanHostMsg,
    HostCmd,
    ReturnType<typeof rec.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ rec: rec.init() }, []],
    update: {
      reconcile: (s, m) => {
        const [slice, cmds] = rec.scan(s.rec, m.at);
        return [{ rec: slice }, cmds];
      },
      resilient_ok: (s, m) => {
        const [slice, cmds] = rec.pageOk(s.rec, m.result, m.at);
        return [{ rec: slice }, cmds];
      },
      resilient_err: (s, m) => {
        const [slice, cmds] = rec.pageErr(s.rec, m.error, m.at);
        return [{ rec: slice }, cmds];
      },
      change_done: (s, m) => {
        const [slice, cmds] = rec.applied(s.rec, m.change, m.at);
        return [{ rec: slice }, cmds];
      },
      re_plan: (s, m) => {
        const [slice, cmds] = rec.planned(s.rec, m.at, m.changes);
        return [{ rec: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = rec.onTimer(s.rec, m);
        return [{ rec: slice }, cmds];
      },
    },
    subscriptions: (s) => rec.subs(s.rec),
    subscribe: { deadline: () => () => {} },
  });
  return { rec, machine };
}

describe("createReconciler — wired re-plan keeps the ledger change-identity-keyed", () => {
  const { machine } = makeRePlanMachine();
  const bound = bindMachine(machine, ctx);

  it("a re-plan applies a NEW change that lands at an already-applied slot (no silent drop)", () => {
    const { state, cmds } = bound.replay({
      msgs: [
        { type: "reconcile", at: 0 },
        // a@1 lags → plan [a]; b & c at target.
        okMsg(page(0, [node("a", 1), node("b", 2), node("c", 2)], true), 0),
        // confirm a → ledger holds a's identity; reconcile would be done.
        { type: "change_done", change: { nodeId: "a", to: 2 }, at: 0 },
        // DESIRED change → re-plan with a brand-new, never-applied change `b→3`
        // that now sits at plan index 0 (the slot `a` occupied).
        { type: "re_plan", at: 0, changes: [{ nodeId: "b", to: 3 }] },
      ],
    });

    // END STATE: the re-planned change b MUST be applied — the position-keyed
    // default skipped it (treated it as already-done because slot 0 was), the
    // identity-keyed default emits it.
    expect(cmds).toContainEqual(applyCmd("b", 3));
    // The reconcile is mid-apply (waiting on b's confirm), NOT prematurely done.
    expect(state.rec.phase).toBe("applying");
  });

  it("after the re-plan's change confirms, the reconcile reaches done with both changes in the ledger", () => {
    const { state } = bound.replay({
      msgs: [
        { type: "reconcile", at: 0 },
        okMsg(page(0, [node("a", 1), node("b", 2), node("c", 2)], true), 0),
        { type: "change_done", change: { nodeId: "a", to: 2 }, at: 0 },
        { type: "re_plan", at: 0, changes: [{ nodeId: "b", to: 3 }] },
        // confirm the re-planned change → reconcile settles done.
        { type: "change_done", change: { nodeId: "b", to: 3 }, at: 0 },
      ],
    });

    expect(state.rec.phase).toBe("done");
    // Both the original AND the re-planned change are recorded — distinct
    // identities, so neither overwrote/aliased the other.
    const ids = Object.keys(state.rec.applied.entries);
    expect(ids).toHaveLength(2);
  });
});

// ===========================================================================
// Properties — invariants over arbitrary verb sequences.
// ===========================================================================

describe("createReconciler — properties", () => {
  it("verbs never mutate their input state (immutability, whole graph)", () => {
    const rec = make({ ...baseConfig, rateLimit: undefined });
    fc.assert(
      fc.property(fc.nat(100_000), (at) => {
        // Every verb input is deep-frozen: the slice record AND its nested
        // `walk` sub-slice, `actual` / `plan` arrays, and `applied` ledger. A
        // verb that mutated any nested field would throw in strict mode.
        const s0 = deepFreeze(rec.init());
        const [s1] = rec.scan(s0, at);
        expect(s1).not.toBe(s0);

        // A mid-scan slice carries a non-empty `actual` array — freeze it whole
        // and run the page verbs against it to catch a nested array splice.
        const mid = deepFreeze(rec.pageOk(s1, page(0, [node("a", 1)]), at)[0]);
        const [s2] = rec.pageOk(mid, page(1, [node("b", 1)]), at);
        const [s3] = rec.pageErr(mid, "e", at);
        expect(s2).not.toBe(mid);
        expect(s3).not.toBe(mid);

        // An applying slice carries a `plan` array + a populated `applied`
        // ledger — freeze the whole graph and drive the apply loop against it.
        const applying = deepFreeze(
          rec.pageOk(s1, page(0, [node("a", 1), node("c", 0)], true), at)[0],
        );
        const [s4] = rec.applyNext(applying, at);
        const [s5] = rec.applied(applying, { nodeId: "a", to: 2 }, at);
        expect(s4).not.toBe(applying);
        expect(s5).not.toBe(applying);
        return true;
      }),
    );
  });

  it("at most one effect (scan-fetch OR apply) is emitted per verb call", () => {
    const rec = make();
    type Action =
      | { kind: "scan"; at: number }
      | { kind: "ok"; last: boolean; at: number }
      | { kind: "err"; at: number }
      | { kind: "done"; at: number }
      | { kind: "retry"; at: number };
    const action = fc.oneof(
      fc.record({ kind: fc.constant("scan" as const), at: fc.nat(20_000) }),
      fc.record({
        kind: fc.constant("ok" as const),
        last: fc.boolean(),
        at: fc.nat(20_000),
      }),
      fc.record({ kind: fc.constant("err" as const), at: fc.nat(20_000) }),
      fc.record({ kind: fc.constant("done" as const), at: fc.nat(20_000) }),
      fc.record({ kind: fc.constant("retry" as const), at: fc.nat(20_000) }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 50 }), (actions: Action[]) => {
        let s = rec.init();
        let off = 0;
        let cur = 0;
        const ids = ["a", "b", "c", "d"] as const;
        // Pick a definite id by ring index — the modulo keeps `n` in range, and
        // `?? ids[0]` makes the access total (typed `string`, no `!` assertion).
        const idAt = (n: number): string => ids[n % ids.length] ?? ids[0];
        for (const a of actions) {
          let cmds: readonly Cmd[] = [];
          switch (a.kind) {
            case "scan":
              [s, cmds] = rec.scan(s, a.at);
              break;
            case "ok":
              [s, cmds] = rec.pageOk(
                s,
                page(off++, [node(idAt(off), 0)], a.last),
                a.at,
              );
              break;
            case "err":
              [s, cmds] = rec.pageErr(s, "e", a.at);
              break;
            case "done":
              [s, cmds] = rec.applied(s, { nodeId: idAt(cur++), to: 2 }, a.at);
              break;
            case "retry":
              [s, cmds] = rec.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:retry:${PAGE_KEY}`,
                atMs: a.at,
              });
              break;
          }
          // A single scan-fetch, OR a single apply — never a fan-out. (The two
          // never co-occur: scan emits fetches, the apply loop emits applies.)
          const fetches = cmds.filter((c) => c.type === "resilient_run").length;
          const applies = cmds.filter((c) => c.type === "apply_change").length;
          if (fetches > 1 || applies > 1) return false;
          if (fetches + applies > 1) return false;
        }
        return true;
      }),
    );
  });

  it("a clean reconcile applies each lagging node exactly once, in desired order", () => {
    fc.assert(
      fc.property(
        // arbitrary actual versions for a..c; target 2.
        fc.record({
          a: fc.integer({ min: 0, max: 4 }),
          b: fc.integer({ min: 0, max: 4 }),
          c: fc.integer({ min: 0, max: 4 }),
        }),
        (versions) => {
          const rec = make({ ...baseConfig, rateLimit: undefined });
          let s = rec.init();
          [s] = rec.scan(s, 0);
          const actualNodes = [
            node("a", versions.a),
            node("b", versions.b),
            node("c", versions.c),
          ];
          let cmds: readonly Cmd[];
          [s, cmds] = rec.pageOk(s, page(0, actualNodes, true), 0);

          // The changes that SHOULD be applied: every id whose version < 2,
          // in desired.ids order.
          const expected = (["a", "b", "c"] as const).filter(
            (id) => versions[id] < 2,
          );

          const applied: string[] = [];
          // Drive the apply loop to completion.
          let guard = 0;
          while (s.phase === "applying" && guard++ < 10) {
            const next = cmds.find((c) => c.type === "apply_change") as
              | ApplyCmd
              | undefined;
            if (!next) break;
            applied.push(next.change.nodeId);
            [s, cmds] = rec.applied(s, next.change, 0);
          }

          expect(applied).toEqual(expected);
          expect(s.phase).toBe("done");
          // Every applied change is in the ledger; no extras.
          expect(Object.keys(s.applied.entries).sort()).toEqual(
            [...expected].sort(),
          );
          return true;
        },
      ),
    );
  });

  it("replay is deterministic: the same msg sequence yields the same final state", () => {
    const { machine } = makeMachine();
    const msgArb = fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant("reconcile" as const),
          at: fc.nat(10_000),
        }),
        fc.record({
          type: fc.constant("resilient_ok" as const),
          key: fc.constant(PAGE_KEY),
          result: fc.record({
            offset: fc.nat(20),
            nodes: fc.constant([node("a", 0)] as const),
            last: fc.boolean(),
          }),
          at: fc.nat(10_000),
        }),
        fc.record({
          type: fc.constant("change_done" as const),
          change: fc.constant({ nodeId: "a", to: 2 } as const),
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
  // DURABILITY GUARD (package-wide canon). Every reachable TERMINAL slice must
  // round-trip through JSON unchanged: a Durable-Object eviction persists the
  // slice with `JSON.stringify` and resumes by `JSON.parse` — if the in-memory
  // slice ≠ the re-parsed one, the resumed reconcile is silently different from
  // the one that was saved. The reconciler has two terminal phases, `done` and
  // `failed`; this property reaches BOTH across arbitrary inputs and asserts
  // stringify → parse → deep-equal. The `failed` slice is the load-bearing case:
  // it carries the scan's terminal error sentinel inside
  // `walk.resilience.calls[PAGE_KEY].error`; an `Error` object there would
  // stringify to `{}` and break the round-trip — only a plain-data `{_tag,...}`
  // sentinel survives. (`done` also exercises the `applied` ledger entries with
  // their baked-in `Number.MAX_SAFE_INTEGER` expiry.)
  // -------------------------------------------------------------------------
  it("every reachable terminal slice round-trips through JSON unchanged (durable)", () => {
    fc.assert(
      fc.property(
        // Arbitrary actual versions for a..c (target 2) → arbitrary non-empty
        // plans, fully applied, settling `done`.
        fc.record({
          a: fc.integer({ min: 0, max: 4 }),
          b: fc.integer({ min: 0, max: 4 }),
          c: fc.integer({ min: 0, max: 4 }),
        }),
        fc.nat(1_000_000),
        (versions, at) => {
          const rec = make({ ...baseConfig, rateLimit: undefined });

          // --- terminal phase `done` ---
          let done = rec.init();
          [done] = rec.scan(done, at);
          let cmds: readonly Cmd[];
          [done, cmds] = rec.pageOk(
            done,
            page(
              0,
              [
                node("a", versions.a),
                node("b", versions.b),
                node("c", versions.c),
              ],
              true,
            ),
            at,
          );
          let guard = 0;
          while (done.phase === "applying" && guard++ < 10) {
            const next = cmds.find((c) => c.type === "apply_change") as
              | ApplyCmd
              | undefined;
            if (!next) break;
            [done, cmds] = rec.applied(done, next.change, at);
          }
          expect(done.phase).toBe("done");
          expect(JSON.parse(JSON.stringify(done))).toEqual(done);

          // --- terminal phase `failed` ---
          // Exhaust the scan's page-fetch retries (maxAttempts 3) → the scan
          // call settles `failed`, escalating the whole reconcile to `failed`.
          let failed = rec.init();
          [failed] = rec.scan(failed, at);
          for (let i = 0; i < 3; i++) {
            [failed] = rec.onTimer(failed, {
              type: "deadline_exceeded",
              id: `resilient:retry:${PAGE_KEY}`,
              atMs: at,
            });
            // A non-`Error` plain-data error keeps the sentinel JSON-stable; an
            // `Error` here would already round-trip to `{}` inside resilient-call.
            [failed] = rec.pageErr(failed, { _tag: "scan_failed", i }, at);
          }
          expect(failed.phase).toBe("failed");
          expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
          return true;
        },
      ),
    );
  });
});
