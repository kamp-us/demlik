/**
 * Tracer test — Layer 3 (hand-written Diataxis prose).
 *
 * This RUNS the happy paths the tutorial + how-to guides teach, against the
 * REAL public API — the assembled thing, not a stub. If a doc's code block
 * would not compile or would not advance a machine, this file fails.
 *
 * Import style: the package's PUBLIC barrels, via the same source paths the
 * in-src tests already use (`../index`, `../retry-backoff/index`, …). vitest
 * runs against source here (no build step), so the `@demlik/tea/*` subpath
 * specifiers the `examples/` corpus uses do not resolve — the relative barrel
 * is the most-public path that resolves to source, and it is still the public
 * API (never a reach into a private internal module).
 *
 * Discipline (mirrors b8e's tracer): SHAPE assertions only — terminal-phase
 * equality, `.some(...)`, `toBeGreaterThan(0)` — never an exact run-length /
 * message count. Every block asserts the machine ADVANCED past its initial
 * state, so a silent-empty-green (a test that folded zero messages) is a hard
 * fail. The reducer / interpret / run core stays REAL; only the React DOM
 * render boundary is omitted (node has no renderer), the same way b8e doubled
 * only browser + network and kept the real engine.
 */

import { describe, expect, it } from "vitest";
import {
  type Cmd,
  defineMachine,
  replay,
  run,
  type Store,
  tryInterpret,
} from "../index";
import { useMachine } from "../react/index";
import {
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  type RetryState,
  recordFailure,
  shouldRetry,
} from "../retry-backoff/index";
import { expectCmdEmitted, expectFinalState } from "../testing/index";

// ───────────────────────────────────────────────────────────────────────────
// The TUTORIAL machine — a tiny download that reaches a terminal "done".
// A reader builds exactly this: Model + Msg + `update`, no Cmd, no Ctx.
// ───────────────────────────────────────────────────────────────────────────

type DlPhase = "idle" | "downloading" | "done";
interface DlState {
  readonly phase: DlPhase;
  readonly received: number;
  readonly total: number;
}
type DlMsg =
  | { readonly type: "start"; readonly total: number }
  | { readonly type: "chunk"; readonly size: number };

const downloader = defineMachine<DlState, DlMsg, never, never, undefined>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [{ phase: "idle", received: 0, total: 0 }, []],
  update: {
    start: (s, m) => [
      { ...s, phase: "downloading", received: 0, total: m.total },
      [],
    ],
    chunk: (s, m) => {
      if (s.phase !== "downloading") return [s, []];
      const received = s.received + m.size;
      return received >= s.total
        ? [{ ...s, received: s.total, phase: "done" }, []]
        : [{ ...s, received }, []];
    },
  },
});

const dlDone = (s: DlState): boolean => s.phase === "done";
// The exact message sequence the tutorial dispatches, reused by `replay`.
const DL_MSGS: readonly DlMsg[] = [
  { type: "start", total: 3 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
];

describe("tutorial — build and replay your first machine", () => {
  it("runs to the terminal phase the lesson teaches", async () => {
    const runtime = await run(downloader, {
      ctx: undefined,
      terminal: dlDone,
    }).ready;

    expect(runtime.getState().phase).toBe("idle"); // initial
    for (const msg of DL_MSGS) await runtime.dispatch(msg);
    const final = await runtime.done();

    // advanced past init, reached the taught terminal
    expect(final.phase).toBe("done");
    expect(final.received).toBeGreaterThan(0);
    expect(final.received).toBe(final.total);
    await runtime.stop();
  });

  it("replay reproduces the SAME terminal Model — tea's determinism claim", async () => {
    const runtime = await run(downloader, {
      ctx: undefined,
      terminal: dlDone,
    }).ready;
    for (const msg of DL_MSGS) await runtime.dispatch(msg);
    const live = await runtime.done();
    await runtime.stop();

    // Pure replay of the same messages — no Store, no interpret, no subs.
    const { state: replayed } = replay(downloader, {
      msgs: DL_MSGS,
      ctx: undefined,
    });
    expect(replayed).toEqual(live); // determinism: same input → same Model
    expect(replayed.phase).toBe("done"); // and it genuinely advanced
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HOW-TO 1 — Add resilience (retry/backoff) to a call.
// Grounded in `./retry-backoff` (pure ops folded in `update`) + resilient-fetch.
// ───────────────────────────────────────────────────────────────────────────

type RfPhase = "idle" | "fetching" | "waiting_retry" | "ok" | "failed";
interface RfState {
  readonly phase: RfPhase;
  readonly body: string | null;
  readonly retryAtMs: number;
  readonly retry: RetryState;
}
type DoFetch = Cmd<"do_fetch"> & { readonly url: string };
type RfMsg =
  | { readonly type: "fetch"; readonly url: string; readonly at: number }
  | { readonly type: "fetch_ok"; readonly body: string }
  | { readonly type: "fetch_err"; readonly error: string; readonly at: number };
interface RfCtx {
  readonly http: (url: string) => Promise<string>;
}

const resilientFetch = defineMachine<RfState, RfMsg, DoFetch, never, RfCtx>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [{ phase: "idle", body: null, retryAtMs: 0, retry: initRetry() }, []],
  update: {
    // The attempt emits the effect as DATA — the reducer runs nothing.
    fetch: (s, m) => [
      { ...s, phase: "fetching", body: null },
      [{ type: "do_fetch", url: m.url }],
    ],
    fetch_ok: (s, m) => [
      { ...s, phase: "ok", body: m.body, retry: initRetry() },
      [],
    ],
    // The failure folds retry-backoff's pure ops: record → decide → schedule.
    fetch_err: (s, m) => {
      const retry = recordFailure(s.retry, m.error);
      if (!shouldRetry(retry, defaultRetryPolicy)) {
        return [{ ...s, retry, phase: "failed" }, []];
      }
      return [
        {
          ...s,
          retry,
          phase: "waiting_retry",
          retryAtMs: m.at + nextDelayMs(retry, defaultRetryPolicy),
        },
        [],
      ];
    },
  },
  interpret: {
    do_fetch: tryInterpret<DoFetch, string, RfMsg, RfCtx>(
      (cmd, ctx) => ctx.http(cmd.url),
      (body) => ({ type: "fetch_ok", body }),
      (err) => ({ type: "fetch_err", error: String(err), at: Date.now() }),
    ),
  },
});

describe("how-to — add resilience (retry/backoff) to a call", () => {
  const ctx: RfCtx = { http: () => Promise.resolve("ok") };

  it("emits the effect Cmd on the attempt", () => {
    // The characteristic shape: the attempt produces a do_fetch effect as data.
    expectCmdEmitted(
      resilientFetch,
      { msgs: [{ type: "fetch", url: "/x", at: 1000 }], ctx },
      { type: "do_fetch", url: "/x" },
    );
  });

  it("schedules a backed-off retry on a transient failure", () => {
    const at = 1000;
    const { state } = replay(resilientFetch, {
      msgs: [
        { type: "fetch", url: "/x", at },
        { type: "fetch_err", error: "503", at },
      ],
      ctx,
    });
    // retry-backoff decided: wait, and the next attempt is scheduled AFTER `at`.
    expect(state.phase).toBe("waiting_retry");
    expect(state.retryAtMs).toBeGreaterThan(at); // backoff advanced the clock
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HOW-TO 2 — Make a machine durable / crash-recoverable.
// Grounded in the public `Store` seam (`./do` is the Cloudflare DO adapter of
// this same shape) + agent-resilient-and-durable ACT 2 (snapshot round-trip).
// ───────────────────────────────────────────────────────────────────────────

/** An in-memory Store standing in for a Durable Object's storage. */
function memStore(box: { snapshot: string | null }): Store<DlState> {
  return {
    load: () => Promise.resolve(box.snapshot),
    save: (state) => {
      box.snapshot = JSON.stringify(state); // the DO persists here
      return Promise.resolve();
    },
    migrate: (raw) => {
      // Boundary parse: recognize the shape or boot fresh. Never throws.
      if (raw === null || typeof raw !== "string") return null;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "phase" in parsed &&
        "received" in parsed
      ) {
        return parsed as DlState;
      }
      return null;
    },
  };
}

describe("how-to — make a machine durable / crash-recoverable", () => {
  it("resumes a fresh runtime from the persisted snapshot", async () => {
    const box = { snapshot: null as string | null };

    // Runtime A: run partway, then the worker is "evicted".
    const a = await run(downloader, { ctx: undefined, store: memStore(box) })
      .ready;
    await a.dispatch({ type: "start", total: 3 });
    await a.dispatch({ type: "chunk", size: 1 });
    const before = a.getState();
    expect(before.phase).toBe("downloading"); // advanced past init
    await a.stop();
    expect(box.snapshot).not.toBeNull(); // the Store actually persisted

    // Runtime B: a FRESH runtime booted from the SAME storage box.
    const b = await run(downloader, { ctx: undefined, store: memStore(box) })
      .ready;
    const resumed = b.getState();
    // It came back exactly where A stopped — no rehydrate code authored.
    expect(resumed.phase).toBe("downloading");
    expect(resumed.received).toBe(before.received);
    expect(resumed.received).toBeGreaterThan(0);
    await b.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HOW-TO 3 — Replay a recorded run in a test.
// Grounded in `replay` (core) + `./testing`'s `expectFinalState`.
// ───────────────────────────────────────────────────────────────────────────

describe("how-to — replay a recorded run in a test", () => {
  it("reconstructs the live terminal Model with zero effects", async () => {
    // The 'recorded run' — what a live machine folded.
    const runtime = await run(downloader, {
      ctx: undefined,
      terminal: dlDone,
    }).ready;
    for (const msg of DL_MSGS) await runtime.dispatch(msg);
    const live = await runtime.done();
    await runtime.stop();

    // `./testing` asserts the replayed final state equals the recorded one.
    expectFinalState(downloader, { msgs: DL_MSGS, ctx: undefined }, live);
    expect(live.phase).toBe("done"); // and the run actually reached terminal
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HOW-TO 4 — Drive a machine from React.
// Grounded in `./react` (`useMachine`). node has no DOM renderer, so we assert
// the export the guide names IS the hook, and drive the exact run-loop the hook
// wraps (`run` → `[state, dispatch]`) so the ENGINE the guide relies on is
// proven real — only the DOM render is omitted (the b8e "double the boundary,
// keep the engine" discipline).
// ───────────────────────────────────────────────────────────────────────────

type CountState = { readonly count: number };
type CountMsg = { readonly type: "inc" };
const counter = defineMachine<CountState, CountMsg, never, never, undefined>({
  init: () => [{ count: 0 }, []],
  update: { inc: (s) => [{ count: s.count + 1 }, []] },
});

describe("how-to — drive a machine from React", () => {
  it("exposes useMachine — the hook the guide names", () => {
    expect(typeof useMachine).toBe("function");
  });

  it("advances state on dispatch through the run-loop useMachine wraps", async () => {
    // `useMachine(machine, { ctx })` internally does `run(machine, { ctx })`
    // and returns `[state, dispatch]`. We drive that engine directly.
    const runtime = await run(counter, { ctx: undefined }).ready;
    expect(runtime.getState().count).toBe(0); // initial
    await runtime.dispatch({ type: "inc" });
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState().count).toBeGreaterThan(0); // advanced on dispatch
    await runtime.stop();
  });
});
