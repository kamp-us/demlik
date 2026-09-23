# Cmd or Sub: do this once, or tell me whenever

Every effect you reach for in `@demlik/tea` is one of two things, and picking the
wrong one produces a machine that appears to hang with nothing in the logs to say
why. Elm draws the line in one sentence each, and this library means it the same
way:

- A **Cmd** is *do this once and tell me*. The machine asked for a piece of work,
  the work runs, and it settles back as a Msg.
- A **Sub** is *tell me whenever*. The machine watches something for as long as a
  state holds, and whatever arrives arrives as a Msg.

## Why the choice is load-bearing

The runtime interprets a transition's Cmds **serially**, awaiting each handler
before it reaches the next one, and it folds nothing else until they have all
settled. That is not an implementation detail that might get optimised away
later — it is the guarantee replay is built on, and
[ADR 0018](../../.decisions/0018-tool-overlap-inside-the-cmd-handler.md)
records the decision to keep it and the rejection of the concurrent alternative.

So a Cmd handler that waits is a Cmd handler that holds the whole machine. Every
message dispatched behind it queues until the wait is over. Nothing throws,
nothing warns; the machine simply stops folding, and you go looking for a
deadlock that is really just a `setTimeout` you put in the wrong place.

A Sub has no such hold. It is opened alongside the fold rather than inside it,
and anything it produces arrives as an ordinary dispatched Msg — one the reducer
folds in its turn, behind whatever else is queued.

## The wrong version: a payment window as a Cmd

A vending machine gives the customer thirty seconds to finish paying. Written as
a Cmd, that reads perfectly reasonably:

```ts
// Don't do this.
const openPaymentWindow = Cmd.define("open_payment_window", {
  input: z.object({ seconds: z.number() }),
  ok: z.object({}),
  err: [],
});

const interpret = {
  open_payment_window: async (cmd, _ctx, { ok }) => {
    await new Promise((resolve) => setTimeout(resolve, cmd.seconds * 1000));
    return ok({});
  },
};
```

The transition that emits it returns, the handler starts its thirty-second
sleep — and the interpret loop is now inside that `await`. Every coin the
customer inserts, every cancel press, every restock message sits in the queue
until the timer fires. The customer's first coin lands half a minute after they
put it in, by which time the window it was meant to keep open has already closed.

## The right version: a payment window as a Sub

The window is not work the machine asked for; it is a thing the machine is
*watching* while it sits in the `awaiting_payment` phase. That is a Sub, and the
machine declares it as data: an entry in `subs` that names the Sub's `type` and
the slice of state it depends on (`deps`). The engine reads both the Sub's
identity and its on/off gate out of that slice: non-null means on, `null` (or
`undefined`) means off, and a change means restart.

A countdown is common enough that every engine ships a runner for it, the
built-in `timer`. Its `deps` are `{ ms, msg }`: dispatch `msg` once, `ms` after
it starts.

```ts
const vendingMachine = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  init: /* … */,
  update: /* … */,
  subs: [
    {
      type: "timer",
      deps: (s) =>
        s.phase === "awaiting_payment"
          ? {
              ms: 30_000,
              msg: { type: "payment_window_expired", saleId: s.saleId },
            }
          : null,
    },
  ],
});
```

Entering `awaiting_payment` starts the timer. Coins fold while it runs, because
nothing is holding the loop. Taking payment — or cancelling — moves `phase` off
`awaiting_payment`, `deps` goes `null`, and the engine stops the timer, so it is
cleared without a single line of teardown in a reducer. Start a second sale and
the `saleId` in `deps` changes, so the old window is stopped and a fresh one
started.

Anything that is not a plain countdown — a poll, a socket, a sensor — is a Sub
type of your own. The machine names it in `types.sub` and declares it in `subs`
exactly the same way. The code that opens the thing is its **runner**, and it
does not live on the machine: it is handed to `run` in `subscribe`, gets the Sub
as `{ id, type, deps }`, and returns the function that closes it.

```ts
type JobPoll = Sub<"job_poll", { readonly jobId: string }>;

const jobs = defineMachine({
  types: { model: {} as State, msg: {} as Msg, sub: {} as JobPoll },
  init: /* … */,
  update: /* … */,
  subs: [
    {
      type: "job_poll",
      deps: (s) => (s.phase === "waiting" ? { jobId: s.jobId } : null),
    },
  ],
});

run(jobs, {
  subscribe: {
    job_poll: (sub, _ctx, dispatch) => {
      const timer = setInterval(
        () => dispatch({ type: "poll_due", jobId: sub.deps.jobId }),
        2_000,
      );
      return () => clearInterval(timer);
    },
  },
});
```

## The rule of thumb

> **If the handler would `await` something that is not the work itself, it is a
> Sub.**

Awaiting the HTTP response *is* the work of a fetch Cmd — keep it. Awaiting a
timer, a poll interval, a sensor reading, a socket frame, a user who has not
acted yet: none of those are the work; they are the waiting *around* some later
work, and they belong in a Sub whose runner opens the thing and whose
`dispatch` delivers whatever it produces.

Applied, that splits the usual cases cleanly:

| You want to… | Shape |
|---|---|
| Call an API and fold the answer | Cmd |
| Write a row, append a file, charge a card | Cmd |
| Give the user 30 seconds | Sub |
| Poll a job until it finishes | Sub |
| Hold a websocket open while a run is live | Sub |
| Retry after a backoff delay | Sub (the delay), then Cmd (the retry) |

The last row is the one worth sitting with: a backoff is two different things
glued together, and separating them is what keeps the machine responsive during
the wait. The Sub sleeps and dispatches a `retry_due` Msg; the reducer folds that
Msg and emits the retry Cmd, which does the work and settles.

## Where each one is documented

`Cmd`, `Cmd.define` and the interpret edge are in the
[reference](../reference/tea.md), as are `Sub`, `DepKeyedSub` and `TimerSub`.
The tutorial introduces the effect list in [Build and replay your first
machine](../tutorial/build-your-first-machine.md), and the ordering guarantee
this page rests on is
[ADR 0018](../../.decisions/0018-tool-overlap-inside-the-cmd-handler.md).
