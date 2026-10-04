/**
 * The retry-and-backoff how-to's compile-and-run gate (#542).
 *
 * `docs/how-to/add-resilience.md` builds a retrying fetch in five steps: a
 * Model slice, the Cmd and Msgs, the machine, the handler table, then a second
 * machine bounded by outage duration. Each block of those steps is a `#region`
 * of this file, verbatim and in page order (`../page-mirrors.ts` holds the
 * row). The regions define every name they use, so the page compiles from its
 * own text too (`../pages-typecheck.test.ts`). The tests below run both
 * machines. Step 6, the `defineAgent` policy, is not mirrored here.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the row this file backs.

import { replay } from "@demlik/tea";
import { expectCmdEmitted } from "@demlik/tea/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

// #region model
import { type RetryState, initRetry } from "@demlik/tea/retry-backoff";

interface State {
  readonly phase: "idle" | "fetching" | "waiting_retry" | "ok" | "failed";
  readonly body: string | null;
  readonly retryAtMs: number;
  readonly retry: RetryState;
}

const initial: State = {
  phase: "idle",
  body: null,
  retryAtMs: 0,
  retry: initRetry(),
};
// #endregion model

// #region cmd
import {
  type Cmd,
  defineMachine,
  type Interpret,
  tryInterpret,
} from "@demlik/tea";

type DoFetch = Cmd<"do_fetch"> & { readonly url: string };

type Msg =
  | { readonly type: "fetch"; readonly url: string }
  | { readonly type: "fetch_ok"; readonly body: string }
  | { readonly type: "fetch_err"; readonly error: string; readonly at: number };

interface Ctx {
  readonly http: (url: string) => Promise<string>;
}
// #endregion cmd

// #region machine
import {
  defaultRetryPolicy,
  nextDelayMs,
  recordFailure,
  shouldRetry,
} from "@demlik/tea/retry-backoff";

const resilientFetch = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as DoFetch,
    ctx: {} as Ctx,
  },
  init: (loaded) => [loaded ?? initial, []],
  update: {
    fetch: (s, m) => [
      { ...s, phase: "fetching", body: null },
      [{ type: "do_fetch", url: m.url }],
    ],
    fetch_ok: (s, m) => [
      { ...s, phase: "ok", body: m.body, retry: initRetry() },
      [],
    ],
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
});
// #endregion machine

// #region run
import { run } from "@demlik/tea/promise";

const ctx: Ctx = {
  http: (url) => fetch(url).then((response) => response.text()),
};

const interpret: Interpret<Msg, DoFetch, Ctx> = {
  do_fetch: tryInterpret<DoFetch, string, Msg, Ctx>(
    (cmd, ctx) => ctx.http(cmd.url),
    (body) => ({ type: "fetch_ok", body }),
    (err) => ({ type: "fetch_err", error: String(err), at: Date.now() }),
  ),
};

const runtime = run(resilientFetch, { ctx, interpret });
// #endregion run

// #region outage-policy
import {
  type DurationRetryPolicy,
  retryElapsedMs,
} from "@demlik/tea/retry-backoff";

/** How long the peer above this call waits before it gives up on it. */
const PEER_GIVE_UP_MS = 10_000;

// Derive the budget from the peer's own give-up window — never restate a guess.
const policy: DurationRetryPolicy = {
  baseMs: 250,
  factor: 2,
  capMs: 4_000,
  maxElapsedMs: PEER_GIVE_UP_MS,
  jitter: "full",
};
// #endregion outage-policy

// #region outage-machine
interface OutageState extends State {
  /** How long the far side had been unreachable when the retrying gave up. */
  readonly outageMs: number | null;
}

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
  },
});
// #endregion outage-machine

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("docs/how-to/add-resilience.md — it runs", () => {
  it("step 3: the attempt emits the call as a Cmd", () => {
    expectCmdEmitted(
      resilientFetch,
      { msgs: [{ type: "fetch", url: "/x" }], ctx },
      { type: "do_fetch", url: "/x" },
    );
  });

  it("steps 3 and 4: a thrown request becomes `fetch_err`, which schedules a backed-off retry", async () => {
    // A flaky backend: the first request throws, every later one answers.
    let requests = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      requests += 1;
      if (requests === 1) throw new Error("503");
      return new Response(`body of ${url}`);
    });
    const booted = await runtime.ready;
    const before = Date.now();

    await booted.dispatch({ type: "fetch", url: "/x" });
    const waiting = booted.getState();
    expect(waiting.phase).toBe("waiting_retry");
    expect(waiting.retry.attempt).toBe(1);
    expect(waiting.retryAtMs).toBeGreaterThanOrEqual(before);

    await booted.dispatch({ type: "fetch", url: "/x" });
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
