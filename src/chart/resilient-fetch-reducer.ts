// ═══════════════════════════════════════════════════════════════════════════
// PORT — `examples/resilient-fetch.ts` in REDUCER form.
//
// The same machine as `resilient-fetch-chart.ts`, with the dimension the
// machine does not have removed. Compare the two `on` sections: there, six
// states each restate the same four edges (24 declarations for 4 facts, and
// `fetch`/`fetch_ok`/`fetch_err` were the 18 the grid charged for nothing).
// Here each event is routed once, because that is how many times the original
// decides it.
//
// Nothing else moved. `ctx`, `events` (with `foreign`), `cmds`, `{ to, cell }`,
// the `to` clamp, the `at` correlator, `MsgIn`'s per-event namespacing — all
// the same machinery, one loop shallower.
// ═══════════════════════════════════════════════════════════════════════════
import {
  get as cacheGet,
  set as cacheSet,
  initCache,
  type TtlCache,
} from "../cache";
import {
  type CircuitState,
  canPass,
  defaultCircuitPolicy,
  initCircuit,
  onFailure,
  onSuccess,
} from "../circuit-breaker";
import { type DeadlineSub, deadlineSub } from "../deadline";
import { initBucket, type TokenBucket, tryConsume } from "../rate-limit";
import type { SubId } from "../pure/core";
import {
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  type RetryState,
  recordFailure,
  shouldRetry,
} from "../retry-backoff";
import { compileReducer, reducerInitFrom } from "./compile";
import {
  type CmdOf,
  type MsgIn,
  type MsgOf,
  type RAssigns,
  type RCells,
  type RStateOf,
  defineReducerChart,
  ty,
} from "./graph";

const CACHE_TTL_MS = 60_000;

/** The five states `attempt()` can land on — the fan-out, written once. */
const ATTEMPT = [
  "succeeded",
  "circuit_open",
  "failed",
  "waiting_retry",
  "fetching",
] as const;

/** `deadline_exceeded` may also leave the state untouched, so it fans out wider. */
const ANY = ["idle", ...ATTEMPT] as const;

export const fetchReducerChart = defineReducerChart({
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
  states: ANY,
  initial: "idle",
  cmds: { do_fetch: ty<{ readonly url: string }>() },
  events: {
    fetch: { data: ty<{ readonly url: string; readonly at: number }>() },
    fetch_ok: {
      data: ty<{
        readonly url: string;
        readonly body: string;
        readonly at: number;
      }>(),
    },
    fetch_err: {
      data: ty<{
        readonly url: string;
        readonly error: string;
        readonly at: number;
      }>(),
    },
    // minted by `@demlik/tea/deadline`, not by us — its name is not ours to
    // namespace, which is exactly what `foreign` says.
    deadline_exceeded: {
      data: ty<{ readonly id: SubId; readonly atMs: number }>(),
      foreign: true,
    },
  },
  // FOUR edges for FOUR cells. `on` is a TOTAL mapped type over `events`, so
  // deleting any line below is a compile error naming the event — the totality
  // obligation, at the one dimension this machine has.
  on: {
    fetch: { to: ATTEMPT, cell: "attempt" },
    fetch_ok: "succeeded",
    fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
    deadline_exceeded: { to: ANY, cell: "retryNow" },
  },
});

export type RFG = typeof fetchReducerChart;
export type RFState = RStateOf<RFG>;
export type RFMsg = MsgOf<RFG>;
export type RFMsgIn<NS extends string> = MsgIn<RFG, NS>;
export type RFDoFetch = CmdOf<RFG>;

/** Exactly the states `ATTEMPT` declares — checked against the edge's `to`. */
type Attempted = { readonly type: (typeof ATTEMPT)[number] } & Omit<RFState, "type">;

/**
 * The original's `attempt()`, VERBATIM apart from `phase:` becoming `type:`.
 */
function attempt(
  s: RFState,
  url: string,
  at: number,
): readonly [Attempted, readonly RFDoFetch[]] {
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

/** The ONE declarative edge: a fixed target, so only its payload is code. */
export const assign: RAssigns<RFG, RFState, RFMsg> = {
  fetch_ok: (s, m) => ({
    ...s,
    circuit: onSuccess(s.circuit, defaultCircuitPolicy),
    cache: cacheSet(s.cache, m.url, m.body, m.at, CACHE_TTL_MS),
    retry: initRetry(),
    body: m.body,
    error: null,
  }),
};

export const cells: RCells<RFG, RFState, RFMsg> = {
  attempt: (s, m) => attempt(s, m.url, m.at),

  onErr: (s, m) => {
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

  // the one place this machine reads its own phase — and it reads it in the
  // cell body, which is where the ORIGINAL read it too. The grid form's
  // `scope: "edges"` moved that fact into the chart; here it stays in code,
  // and the chart honestly declares only that the state may not change.
  retryNow: (s, m) =>
    s.type === "waiting_retry" && s.url !== null
      ? attempt(s, s.url, m.atMs)
      : [s, []],
};

export const fetchReducerRegion = <const NS extends string>(ns: NS) =>
  compileReducer<RFG, RFState, RFMsg, RFDoFetch, NS>(
    fetchReducerChart,
    { assign, cells },
    ns,
  );

export const fetchReducerUpdate = compileReducer(fetchReducerChart, {
  assign,
  cells,
});

export const fetchReducerInit = reducerInitFrom<RFG, RFState, RFDoFetch>(
  fetchReducerChart,
  () => ({
    url: null,
    body: null,
    error: null,
    retryAtMs: 0,
    circuit: initCircuit(),
    bucket: initBucket(10, 5, 0),
    retry: initRetry(),
    cache: initCache<string>(),
  }),
);

export const fetchReducerSubs = (s: RFState): readonly DeadlineSub[] =>
  s.type === "waiting_retry" ? [deadlineSub("retry", s.retryAtMs)] : [];
