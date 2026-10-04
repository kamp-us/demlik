/**
 * The retry-and-backoff how-to's compile-and-run gate (#542).
 *
 * `docs/how-to/add-resilience.md` builds a retrying fetch one piece at a time:
 * a Model slice, two reducer cells, a handler table, then a second failure
 * cell bounded by outage duration. Each piece is a `#region` of this file,
 * verbatim (`../page-mirrors.ts` holds the row), so the page shows code the
 * test program compiles, and the tests below run both machines the pieces
 * make. Step 6, the `defineAgent` policy, is not mirrored here.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the row this file backs.

import { replay } from "@demlik/tea";
import { expectCmdEmitted } from "@demlik/tea/testing";
import { describe, expect, it } from "vitest";

// #region model
import { type RetryState, initRetry } from "@demlik/tea/retry-backoff";

interface State {
  readonly phase: "idle" | "fetching" | "waiting_retry" | "ok" | "failed";
  readonly body: string | null;
  readonly retryAtMs: number;
  readonly retry: RetryState;
}
// #endregion model

type Msg =
  | { readonly type: "fetch"; readonly url: string; readonly at: number }
  | { readonly type: "fetch_ok"; readonly body: string }
  | { readonly type: "fetch_err"; readonly error: string; readonly at: number };

interface Ctx {
  readonly http: (url: string) => Promise<string>;
}

// #region cmd
import {
  type Cmd,
  defineMachine,
  type Interpret,
  tryInterpret,
} from "@demlik/tea";

type DoFetch = Cmd<"do_fetch"> & { readonly url: string };
// #endregion cmd

// #region backoff-ops
import {
  defaultRetryPolicy,
  nextDelayMs,
  recordFailure,
  shouldRetry,
} from "@demlik/tea/retry-backoff";
// #endregion backoff-ops

const initial: State = {
  phase: "idle",
  body: null,
  retryAtMs: 0,
  retry: initRetry(),
};

const resilientFetch = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as DoFetch,
    ctx: {} as Ctx,
  },
  init: (loaded) => [loaded ?? initial, []],
  update: {
    // #region attempt
    fetch: (s, m) => [
      { ...s, phase: "fetching", body: null },
      [{ type: "do_fetch", url: m.url }],
    ],
    // #endregion attempt
    fetch_ok: (s, m) => [
      { ...s, phase: "ok", body: m.body, retry: initRetry() },
      [],
    ],
    // #region failure
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
    // #endregion failure
  },
});

/** A flaky backend: the first request throws, every later one answers. */
let requests = 0;
const ctx: Ctx = {
  http: async (url) => {
    requests += 1;
    if (requests === 1) throw new Error("503");
    return `body of ${url}`;
  },
};

// #region run
import { run } from "@demlik/tea/promise";

const interpret: Interpret<Msg, DoFetch, Ctx> = {
  do_fetch: tryInterpret<DoFetch, string, Msg, Ctx>(
    (cmd, ctx) => ctx.http(cmd.url),
    (body) => ({ type: "fetch_ok", body }),
    (err) => ({ type: "fetch_err", error: String(err), at: Date.now() }),
  ),
};

const runtime = run(resilientFetch, { ctx, interpret });
// #endregion run

/** How long the peer above this call waits before it gives up on it. */
const PEER_GIVE_UP_MS = 10_000;

interface OutageState extends State {
  readonly outageMs: number | null;
}

// #region outage-policy
import {
  type DurationRetryPolicy,
  retryElapsedMs,
} from "@demlik/tea/retry-backoff";

// Derive the budget from the peer's own give-up window — never restate a guess.
const policy: DurationRetryPolicy = {
  baseMs: 250,
  factor: 2,
  capMs: 4_000,
  maxElapsedMs: PEER_GIVE_UP_MS,
  jitter: "full",
};
// #endregion outage-policy

const outageBoundedFetch = defineMachine({
  types: {
    model: {} as OutageState,
    msg: {} as Msg,
    cmd: {} as DoFetch,
    ctx: {} as Ctx,
  },
  init: (loaded) => [loaded ?? { ...initial, outageMs: null }, []],
  update: {
    fetch: (s, m) => [
      { ...s, phase: "fetching", body: null },
      [{ type: "do_fetch", url: m.url }],
    ],
    fetch_ok: (s, m) => [
      { ...s, phase: "ok", body: m.body, retry: initRetry() },
      [],
    ],
    // #region outage-failure
    fetch_err: (s, m) => {
      const retry = recordFailure(s.retry, m.error, m.at); // `m.at` starts the streak clock
      if (!shouldRetry(retry, policy, m.at)) {
        const outageMs = retryElapsedMs(retry, m.at);
        return [{ ...s, retry, phase: "failed", outageMs }, []];
      }
      return [
        {
          ...s,
          retry,
          phase: "waiting_retry",
          retryAtMs: m.at + nextDelayMs(retry, policy),
        },
        [],
      ];
    },
    // #endregion outage-failure
  },
});

describe("docs/how-to/add-resilience.md — it runs", () => {
  it("step 2: the attempt emits the call as a Cmd", () => {
    expectCmdEmitted(
      resilientFetch,
      { msgs: [{ type: "fetch", url: "/x", at: 1_000 }], ctx },
      { type: "do_fetch", url: "/x" },
    );
  });

  it("steps 3 and 4: a thrown request becomes `fetch_err`, which schedules a backed-off retry", async () => {
    const booted = await runtime.ready;
    const before = Date.now();

    await booted.dispatch({ type: "fetch", url: "/x", at: before });
    const waiting = booted.getState();
    expect(waiting.phase).toBe("waiting_retry");
    expect(waiting.retry.attempt).toBe(1);
    expect(waiting.retryAtMs).toBeGreaterThanOrEqual(before);

    await booted.dispatch({ type: "fetch", url: "/x", at: Date.now() });
    expect(booted.getState()).toMatchObject({
      phase: "ok",
      body: "body of /x",
      retry: initRetry(),
    });
    await booted.stop();
  });

  it("step 3: the count bound gives up after `maxAttempts`", () => {
    const failures = Array.from(
      { length: defaultRetryPolicy.maxAttempts },
      (): Msg => ({ type: "fetch_err", error: "503", at: 1_000 }),
    );
    const { state } = replay(resilientFetch, { msgs: failures, ctx });
    expect(state.phase).toBe("failed");
  });

  it("step 5: the outage bound retries inside the window and gives up past it", () => {
    const failAt = (at: number): Msg => ({
      type: "fetch_err",
      error: "503",
      at,
    });

    const inside = replay(outageBoundedFetch, {
      msgs: [failAt(0), failAt(PEER_GIVE_UP_MS - 1)],
      ctx,
    }).state;
    expect(inside.phase).toBe("waiting_retry");

    const past = replay(outageBoundedFetch, {
      msgs: [failAt(0), failAt(PEER_GIVE_UP_MS)],
      ctx,
    }).state;
    expect(past).toMatchObject({ phase: "failed", outageMs: PEER_GIVE_UP_MS });
  });
});
