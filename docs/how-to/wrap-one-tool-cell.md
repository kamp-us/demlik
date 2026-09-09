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
that parses the arguments, calls your handler, and settles.

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

Two `fetch_rate` calls in one model turn now reach the upstream one after the
other instead of together. Nothing else about the run changed.

## Return `next`'s Msg — that is the whole contract

The cell you return settles through the **same typed Cmd→Msg edge** as the cell
it wraps: `next` resolves the `fetch_rate_ok` / `fetch_rate_err` Msg that
`Cmd.define` minted for this tool, carrying the `callId` the fan-out folds on,
and returning it unchanged is what keeps the Model — and therefore a replay —
identical to the unwrapped run's.

So the door is one over the **effect** boundary, never over the fold:

- **Do** await, retry around, log, time, rate-limit, or enrich `ctx` before
  calling `next`.
- **Do not** mint a settle Msg yourself, return a Msg from an earlier call, or
  swallow the one `next` gave you. A cached Msg carries the earlier call's
  `callId`, and the fold will settle the wrong call with it.

A cell that genuinely has to settle differently is a different machine, and
`createAgent` is where you build one.

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
