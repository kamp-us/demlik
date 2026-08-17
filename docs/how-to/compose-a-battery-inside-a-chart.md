# Compose a battery inside a chart

To let a chart route a transition whose target is decided by library code — a
retry ladder, a circuit breaker, a cache, a rate limiter — use a `{ to, cell }`
edge. The chart declares the *set* of states the transition may land on; a
hand-written cell picks one of them and returns the whole transition itself.

Use it when a single binary `when` cannot express the decision. The worked case
below is `resilient-fetch`: one `attempt()` chains four pure batteries and lands
on one of five states.

## 1. Declare the fan-out, once

Write the targets as a `const` tuple so the same list can be reused by every edge
that shares the fan-out:

```ts
/** The five states `attempt()` can land on — the fan-out, written once. */
const ATTEMPT = [
  "succeeded",
  "circuit_open",
  "failed",
  "waiting_retry",
  "fetching",
] as const;
```

## 2. Point the edge at a cell

`to` is the declared target set; `cell` names the function that chooses among
them. Every other edge field is illegal alongside it — a cell already picks the
target and already returns its own Cmds, so `target`, `when`, `otherwise`,
`resume`, `cmd` and `otherwiseCmd` beside it would each be a second, silently
ignored source of the same decision:

```ts
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
    // …
  },
},
```

Note the mix: `fetch_ok` right beside them is a plain declarative edge with an
`assign`. The hatch is an edge kind, not a mode the whole machine switches into.

## 3. Write the cell — the batteries go in its body

The cell receives its site's state and message, exactly as a guard does, and
returns `[nextState, cmds]`. Inside it, the battery modules compose as ordinary
pure functions:

```ts
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
```

A cell edge owes no `assign` entry — the cell returned the whole next state, so a
builder for it would be dead code. It is not merely optional: it is not a key of
the `assign` bag, and writing it anyway is an excess property tsc names.

## 4. Let the clamp check the delegate

The cell's return type is clamped to the states its edge declared in `to`. Give
the helper that return type explicitly and the chart checks the helper, not just
the cell:

```ts
/** Exactly the states `ATTEMPT` declares — the helper's return type IS the
 *  edge's `to`, so the five literals below are checked against the chart. */
type Attempted = Extract<FState, { type: (typeof ATTEMPT)[number] }>;

function attempt(s: FState, url: string, at: number): readonly [Attempted, readonly DoFetch[]] {
  const cached = cacheGet(s.cache, url, at);
  if (cached !== undefined) {
    return [{ ...s, type: "succeeded", url, body: cached, error: null }, []];
  }

  const [circuit, circuitOk] = canPass(s.circuit, defaultCircuitPolicy, at);
  if (!circuitOk) return [{ ...s, circuit, type: "circuit_open", url }, []];
  // …rate limit, then retry, then the happy path with its Cmd
}
```

Return a state the edge did not admit and the diagnostic names the offending
literal: `onErr` is reached from `to: ["failed", "waiting_retry"]`, so returning
`circuit_open` — a real state of this machine, just not one this edge admits — is
rejected.

## 5. The chart still knows the shape

That clamp is the whole bargain. Code may decide, but only among the targets the
chart admits, so nothing that reads the graph goes blind: `chartMermaid` draws
one real edge per declared target, labelled with the cell that picks among them,
with no sampling and no execution.

```
idle --> succeeded : fetch / attempt()
idle --> circuit_open : fetch / attempt()
idle --> failed : fetch / attempt()
…
```

## Limits worth knowing

- **A multi-site cell's return type is the union across its sites.** The
  parameters stay exact per site — `switch (at)` narrows the state and the
  message together — but the return is clamped to the union of every site's `to`.
  A cell used at `a.X` (`to: ["a","b"]`) and `b.Y` (`to: ["a","c"]`) may return
  `a | b | c` from either branch as far as the *return* type is concerned. If
  that matters, use two cells; the second one costs a name.
- **`to` is only as precise as the delegate's declared return type.** The clamp
  checks what the cell returns. If the cell forwards a helper whose return type
  is the whole `FState`, the chart cannot narrow it for you — annotate the helper
  as in step 4.
- **A cmd only ever emitted from inside a cell owes no builder**, because the
  cell built its payload when it built the Cmd. Its name still belongs in the
  chart's `cmds` section: that section is where the Cmd union comes from.

The same edge form, unchanged, exists in the flat reducer chart — see
[author a machine as config](./author-a-machine-as-config.md) step 7.
