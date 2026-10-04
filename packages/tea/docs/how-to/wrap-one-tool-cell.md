# Wrap one tool's interpret cell

**Goal:** give ONE tool of a `defineAgent` agent a behaviour the lid has no
option for — a queue, an audit log, a header the handler cannot see — without
rebuilding the agent with `createAgent`.

`defineAgent` takes three intents; `createAgent` takes fourteen fields. `.with`
is the ramp between them: it wraps a named interpret cell of the machine
`defineAgent` already built and hands back another defined agent. Reach for
`createAgent` when you want a different machine, not when you want one different
cell.

## The wrap point

```ts
const agent = defineAgent({ model, tools: [fetchRate], instructions });

const queued = agent.with({
  interpret: {
    fetch_rate: (next) => async (cmd, ctx, dispatch) =>
      inTurn(() => next(cmd, ctx, dispatch)),
  },
});
```

The key is the tool's **name** — a `tool("fetch_rate", …)` is a `Cmd.define`d
effect whose `type` is that name, and the interpret cell keyed by it is what the
kernel calls to run the tool. `next` is the cell `defineAgent` wired: the one
that calls your handler and returns its outcome. `cmd` is the tool's Cmd, and
`cmd.callId` is the call's id — a `tool()` handler is not handed it, so a
wrapper is where you read it.

`queued` is a whole defined agent — `run`, `machine` and `with` again. The agent
you called `.with` on is unchanged, and every cell you did not name is carried
over by reference, so the other tools run the exact functions the lid built.

Here `inTurn` is an ordinary promise queue, one line of application code the
agent layer never has to know about:

```ts
let tail: Promise<unknown> = Promise.resolve();
function inTurn<A>(job: () => Promise<A>): Promise<A> {
  const next = tail.then(job, job);
  tail = next.catch(() => undefined);
  return next;
}
```

Two runs of `queued` that call `fetch_rate` at the same moment now reach the
upstream one after the other instead of together. Nothing else about either run
changed. Inside one run there is nothing to queue: a turn's tool calls already
go out one at a time.

That holds at the default `toolConcurrency`. Raise it above `1` and the cell
`next` names launches the handler and returns before it has finished, so a
wrapper cannot wait for the work, time it or queue it.

## Return `next`'s outcome — that is the whole contract

`next` resolves an `Outcome`, the value your handler returned through `ok` or
`fail`. It is not a Msg. The engine makes the Msg: it takes what your cell
returns, pairs it with the Cmd it handed you, and mints `fetch_rate_ok` or
`fetch_rate_err`. Returning `next`'s outcome unchanged is what keeps the Model —
and therefore a replay — identical to the unwrapped run's.

So the door is one over the **effect** boundary, never over the fold:

- **Do** await, retry around, log, time, rate-limit, or enrich `ctx` before
  calling `next`.
- **Do not** return a Msg, return an outcome from an earlier call, or swallow
  the one `next` gave you. A Msg is not an outcome, and the engine refuses it
  with an `OutcomeContractError`. An earlier call's outcome settles *this* call
  with that call's result. A cell that returns nothing dispatches nothing, and
  the call never settles.

A cell that genuinely has to settle differently is a different machine, and
`createAgent` is where you build one.

The outcome `next` resolves, and the Msg the engine mints from each arm:

```ts
{ _tag: "Ok", value }    // → { type: "fetch_rate_ok",  cmd, value, at }
{ _tag: "Err", error }   // → { type: "fetch_rate_err", cmd, error, at }
```

`value` is checked against your `ok` schema as the Msg is minted, and `error` is
a `{ _tag, … }` failure. `cmd` is the Cmd you were handed, so the Msg carries
this call's `callId` whatever your cell returned.

## When the tool carries a resilience policy

If the tool declared `timeoutMs` or `retry`, your cell returns the **same
outcome**, and the engine mints the same `fetch_rate_ok` / `fetch_rate_err` from
it. The ladder is in the reducer, not in the effect, so it changes nothing about
what `next` resolves. What it changes is what happens to the minted Msg, and
there are three facts worth knowing before you print one:

- **Your cell can run more than once for one `cmd.callId`.** Each retry attempt
  re-enters the same interpret cell with the same Cmd, so a wrapper that counts
  calls, queues them, or opens a span per call sees one entry per *attempt* — not
  one per model tool call.
- **A failure you pass through may be absorbed.** The reducer offers each
  `fetch_rate_err` to the ladder first; while retry budget remains it arms a
  timer and folds nothing, so that failure never reaches the conversation.
  Returning the outcome unchanged is still the whole contract — the absorbing is
  the reducer's call, not yours.
- **The call's final failure may be authored without your cell running at all.**
  When the budget is spent the reducer settles the call itself, with a
  `{ kind: "error", _tag, reason }` failure carrying `_tag: "timeout"` or
  `_tag: "retry_exhausted"` (the latter also carrying `attempts` and the last
  attempt's `last` reason). That failure is not a `fetch_rate_err` Msg and never
  passes through an interpret cell, so a wrapper cannot observe it —
  `defineAgent`'s `onToolError` is where it surfaces.

A timeout also does not cancel the attempt in flight: the handler, and your
wrapper around it, runs to its own end, and the outcome it eventually returns
arrives for a call nothing is waiting on and folds nothing. So a wrapper's
`finally` still fires, and what it returns still means nothing.

If you were reaching for `resilient_run_ok` / `resilient_run_err` — those are the agent's
own private settle Msgs for the brain call and for compaction. No tool settles
through them, and a wrapped tool cell never sees one.

## Composing, and the error you will meet

`with` stacks. The later call is the **outer** wrapper:

```ts
const traced = queued.with({
  interpret: {
    fetch_rate: (next) => async (cmd, ctx, dispatch) => {
      console.time(cmd.callId);
      try {
        return await next(cmd, ctx, dispatch);
      } finally {
        console.timeEnd(cmd.callId);
      }
    },
  },
});
```

`traced` enters the timing wrapper first, and its `next` is the queueing cell.

Naming a cell the machine has none of throws at `machine(input)` — where the
table to check the name against exists — with the cell names it does have in the
message. TypeScript catches the typo first for a statically-known tool set; the
throw is for the config that arrived as data.

## What this is not for

- **Bounding or retrying one tool** — `tool()` takes `timeoutMs` and `retry`,
  and those run in the reducer, so a process killed between two attempts resumes
  on the attempt it was on. A `for` loop inside a wrapper cannot. See
  [Add retry and backoff to a call](./add-resilience.md).
- **Watching failures** — `defineAgent`'s `onToolError` is the typed seam for
  that, and it fires once per failed call with the tag and payload. See
  [Handle a tool failure](./handle-a-tool-failure.md).
- **Watching progress** — `onEvent` and `onChunk` on `run`. See
  [Show a run's progress while it runs](./show-a-run-in-progress.md).

Reach for `.with` when the thing you need is none of those and lives strictly
inside one effect.
