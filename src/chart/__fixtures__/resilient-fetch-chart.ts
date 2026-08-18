// ═══════════════════════════════════════════════════════════════════════════
// PORT — `examples/resilient-fetch.ts` in the config form.
//
// This is the machine the declarative edge could not express. Its `attempt()`
// composes FOUR pure modules (cache → circuit-breaker → rate-limit → retry)
// and picks one of FIVE next states from what they return:
//
//     cache hit                        → succeeded
//     breaker open                     → circuit_open
//     rate-limited AND out of retries  → failed
//     rate-limited, retries left       → waiting_retry
//     all gates passed                 → fetching  + a Cmd
//
// An edge with one binary `when` can name two targets. This one needs five,
// chosen by a chain of library calls whose policies are not the chart's to
// read. `to: [...]` declares the five; the cell picks. The chart still owns
// every name, every payload, the totality obligation and the drawing — and the
// cell owns exactly the one thing that was never declarable.
//
// Note the MIX: `fetch_ok` right below is a plain declarative edge with an
// `assign`, in the same chart as three cell edges. The hatch is an edge kind,
// not a mode the whole machine has to switch into.
// ═══════════════════════════════════════════════════════════════════════════
import {
  get as cacheGet,
  set as cacheSet,
  initCache,
  type TtlCache,
} from "../../cache";
import {
  type CircuitState,
  canPass,
  defaultCircuitPolicy,
  initCircuit,
  onFailure,
  onSuccess,
} from "../../circuit-breaker";
import { type DeadlineSub, deadlineSub } from "../../deadline";
import type { SubId } from "../../pure/core";
import { initBucket, type TokenBucket, tryConsume } from "../../rate-limit";
import {
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  type RetryState,
  recordFailure,
  shouldRetry,
} from "../../retry-backoff";
import { compile, initFrom } from "../compile";
import {
  type Assigns,
  type Cells,
  type CmdOf,
  defineChart,
  type MsgIn,
  type MsgOf,
  type StateOf,
  ty,
} from "../graph";

const CACHE_TTL_MS = 60_000;

/** The five states `attempt()` can land on — the fan-out, written once. */
const ATTEMPT = [
  "succeeded",
  "circuit_open",
  "failed",
  "waiting_retry",
  "fetching",
] as const;

export const fetchChart = defineChart({
  ctx: ty<{
    readonly url: string | null;
    readonly body: string | null;
    readonly error: string | null;
    readonly retryAtMs: number;
    readonly circuit: CircuitState;
    readonly bucket: TokenBucket;
    readonly retry: RetryState;
    readonly cache: TtlCache<string>;
  }>(),
  cmds: { do_fetch: ty<{ readonly url: string }>() },
  events: {
    fetch: {
      data: ty<{ readonly url: string; readonly at: number }>(),
      scope: "run",
    },
    fetch_ok: {
      data: ty<{
        readonly url: string;
        readonly body: string;
        readonly at: number;
      }>(),
      scope: "run",
    },
    fetch_err: {
      data: ty<{
        readonly url: string;
        readonly error: string;
        readonly at: number;
      }>(),
      scope: "run",
    },
    // the retry timer only exists while parked in `waiting_retry`; everywhere
    // else the original's `s.phase === "waiting_retry" ? … : [s, []]` guard IS
    // a scoped-out self-loop, so `scope: "edges"` says it in one word.
    deadline_exceeded: {
      data: ty<{ readonly id: SubId; readonly atMs: number }>(),
      scope: "edges",
    },
  },
  states: {
    run: {
      idle: {
        initial: true,
        on: {
          fetch: { to: ATTEMPT, cell: "attempt" },
          fetch_ok: "succeeded",
          fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
        },
      },
      fetching: {
        on: {
          fetch: { to: ATTEMPT, cell: "attempt" },
          fetch_ok: "succeeded",
          fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
        },
      },
      waiting_retry: {
        on: {
          fetch: { to: ATTEMPT, cell: "attempt" },
          fetch_ok: "succeeded",
          fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
          // the same battery-driven decision, reached from the timer instead
          // of from a user fetch — a second cell because the MSG differs.
          deadline_exceeded: { to: ATTEMPT, cell: "retryNow" },
        },
      },
      circuit_open: {
        on: {
          fetch: { to: ATTEMPT, cell: "attempt" },
          fetch_ok: "succeeded",
          fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
        },
      },
      succeeded: {
        on: {
          fetch: { to: ATTEMPT, cell: "attempt" },
          fetch_ok: "succeeded",
          fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
        },
      },
      failed: {
        on: {
          fetch: { to: ATTEMPT, cell: "attempt" },
          fetch_ok: "succeeded",
          fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
        },
      },
    },
  },
});

export type FG = typeof fetchChart;
export type FState = StateOf<FG>;
export type FMsg = MsgOf<FG>;
export type FMsgIn<NS extends string> = MsgIn<FG, NS>;
export type DoFetch = CmdOf<FG>;
/** Exactly the states `ATTEMPT` declares — the helper's return type IS the
 *  edge's `to`, so the five literals below are checked against the chart. */
type Attempted = Extract<FState, { type: (typeof ATTEMPT)[number] }>;

/**
 * The original's `attempt()`, VERBATIM apart from `phase:` becoming `type:`.
 * Its return type is the union the chart declared in `ATTEMPT`, so every one of
 * the five literals below is checked against the edge — and a sixth would be a
 * compile error naming the state that is not in `to`.
 */
function attempt(
  s: FState,
  url: string,
  at: number,
): readonly [Attempted, readonly DoFetch[]] {
  const cached = cacheGet(s.cache, url, at);
  if (cached !== undefined) {
    return [{ ...s, type: "succeeded", url, body: cached, error: null }, []];
  }

  const [circuit, circuitOk] = canPass(s.circuit, defaultCircuitPolicy, at);
  if (!circuitOk) return [{ ...s, circuit, type: "circuit_open", url }, []];

  const [bucket, hasToken] = tryConsume(s.bucket, at);
  if (!hasToken) {
    const retry = recordFailure(s.retry, "rate_limited");
    if (!shouldRetry(retry, defaultRetryPolicy)) {
      return [
        {
          ...s,
          circuit,
          bucket,
          retry,
          type: "failed",
          url,
          error: "rate limited; out of retries",
        },
        [],
      ];
    }
    return [
      {
        ...s,
        circuit,
        bucket,
        retry,
        type: "waiting_retry",
        url,
        retryAtMs: at + nextDelayMs(retry, defaultRetryPolicy),
      },
      [],
    ];
  }

  return [
    { ...s, circuit, bucket, type: "fetching", url, error: null },
    [{ type: "do_fetch", url }],
  ];
}

export const cells: Cells<FG, FState, FMsg> = {
  // SIX sites (one per state), all with the same msg — so the `at` correlator
  // is declared and unused, and the body reads only `ctx` fields every site has.
  attempt: (s, m, _at) => attempt(s, m.url, m.at),

  // TWO targets, chosen by `shouldRetry` against a policy the chart cannot read.
  onErr: (s, m, _at) => {
    const circuit = onFailure(s.circuit, defaultCircuitPolicy, m.at);
    const retry = recordFailure(s.retry, m.error);
    if (!shouldRetry(retry, defaultRetryPolicy)) {
      return [{ ...s, circuit, retry, type: "failed", error: m.error }, []];
    }
    return [
      {
        ...s,
        circuit,
        retry,
        type: "waiting_retry",
        retryAtMs: m.at + nextDelayMs(retry, defaultRetryPolicy),
      },
      [],
    ];
  },

  // one site. `url === null` is the original's own second condition; staying
  // put is a legal member of `to`, so it needs no special case in the chart.
  retryNow: (s, m) => (s.url !== null ? attempt(s, s.url, m.atMs) : [s, []]),
};

/** The one DECLARATIVE edge's payload — `fetch_ok` needs no decision at all. */
export const assign: Assigns<FG, FState, FMsg> = {
  "idle.fetch_ok": ok,
  "fetching.fetch_ok": ok,
  "waiting_retry.fetch_ok": ok,
  "circuit_open.fetch_ok": ok,
  "succeeded.fetch_ok": ok,
  "failed.fetch_ok": ok,
};

function ok(
  s: FState,
  m: Extract<FMsg, { type: "fetch_ok" }>,
): Omit<FState, "type"> {
  return {
    ...s,
    circuit: onSuccess(s.circuit, defaultCircuitPolicy),
    cache: cacheSet(s.cache, m.url, m.body, m.at, CACHE_TTL_MS),
    retry: initRetry(),
    body: m.body,
    error: null,
  };
}

export function fetchRegion<const NS extends string>(ns: NS) {
  return compile<FG, FState, FMsg, DoFetch, NS>(
    fetchChart,
    { assign, cells },
    ns,
  );
}

export const fetchInit = initFrom<FG, FState, DoFetch>(fetchChart, () => ({
  url: null,
  body: null,
  error: null,
  retryAtMs: 0,
  circuit: initCircuit(),
  bucket: initBucket(10, 5, 0),
  retry: initRetry(),
  cache: initCache<string>(),
}));

export const fetchUpdate = fetchRegion("RF");

export const fetchSubs = (s: FState): readonly DeadlineSub[] =>
  s.type === "waiting_retry" ? [deadlineSub("retry", s.retryAtMs)] : [];
