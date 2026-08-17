# Durable checkout saga

A checkout that survives having its server destroyed mid-retry — built on
[`@demlik/tea`](../../README.md) with its Cmd handlers written as Effect
programs through the [`@demlik/tea/effect`](../../src/effect/index.ts) bridge.

The page runs the same order twice, side by side, and gives you one button that
kills the machine both are running on:

- **Lane A — the ordinary way.** The retry ladder is a loop variable and an
  `await sleep(delay)` inside a running function. This is what a `Schedule`, a
  `p-retry` loop, or a hand-rolled `setTimeout` chain gives you.
- **Lane B — with tea.** The attempt number and the timestamp the next attempt
  is due are fields in the reducer's State, saved to Durable Object storage on
  every transition, with the wait expressed as a DO alarm.

Uncrashed, both settle identically — the comparison is fair. Then you press
**💥 Kill the server**, which calls `ctx.abort()` and genuinely destroys the
isolate. Lane A's status row says `retrying…` forever, because the only thing
that was going to continue it was the stack frame that just evaporated. Lane B's
alarm comes due, the platform starts a fresh isolate, that isolate reloads State
through the Store, and the order reaches `settled`.

Nothing about this is possible when the ladder lives in the process. That is the
whole argument.

## Run it locally

```sh
cd examples/checkout-saga
npm install
npx wrangler dev --port 8790
```

Open <http://localhost:8790>. Press **Start both orders**, wait for the first
decline, then kill the server. The payment declines three times with a 3s / 6s /
12s backoff, so there is about twenty seconds of retrying to talk over before
you have to press anything.

Order ids containing `oos` are out of stock, which runs the refund
(compensation) path instead of settling.

Run the machine tests:

```sh
npx vitest run
```

## Driving it with curl

```sh
# start both lanes on one order id
curl -sX POST 'localhost:8790/both/start?order=demo-1'

# read both lanes
curl -s 'localhost:8790/both/state?order=demo-1'

# destroy both isolates
curl -sX POST 'localhost:8790/both/crash?order=demo-1'
```

`/order/*` and `/naive/*` address a single lane; `/both/*` fans out to both.
Each also supports `reset`.

## The files

| File | What it is |
| --- | --- |
| [`src/machine.ts`](src/machine.ts) | The saga, pure. States, messages, commands, and the reducer — including the retry ladder as ordinary State. No Effect, no Durable Object, no clock. |
| [`src/services.ts`](src/services.ts) | The Effect side: `Payments` and `Inventory` services with tagged errors, and the `Layer` providing the fake implementations. |
| [`src/handlers.ts`](src/handlers.ts) | The bridge. Each command handler is an `Effect.gen` program; `toInterpret` lowers the dictionary into tea's handler table. |
| [`src/worker.ts`](src/worker.ts) | The host. The `CheckoutSaga` Durable Object (Store + alarm + `ManagedRuntime`) and the worker routes. |
| [`src/naive.ts`](src/naive.ts) | The control lane. The same saga in plain async code, with the ladder in memory. Deliberately does not use tea. |
| [`src/page.ts`](src/page.ts) | The UI, as one inline HTML string. No framework, no build step. |
| [`test/machine.test.ts`](test/machine.test.ts) | Happy path, compensation, retry-budget exhaustion, restart semantics, and a resume-from-storage test that kills the runtime mid-ladder. |

## The parts worth reading

- **The retry ladder as State** — [`src/machine.ts`](src/machine.ts), the
  `payment_failed` and `retry_now` cells. `attempt` and `nextRetryAt` are just
  fields; `payment_failed` computes the next due time and stores it, `retry_now`
  spends it. Because they are State, they are whatever the Store persisted.
- **The bridge call** — [`src/handlers.ts`](src/handlers.ts), the `toInterpret`
  call. Note every handler ends in a `catchTag` that folds its typed failure
  into a Msg: the bridge requires the error channel be discharged inside the
  effect, because tea has exactly one failure vocabulary, the Msg union.
- **The alarm wiring** — [`src/worker.ts`](src/worker.ts), the `durableTimer`
  block in `#boot`. `nextDeadline` reads `nextRetryAt` straight off live State,
  which is what makes the cold-wake re-arm identical to the never-evicted one.
- **The crash** — [`src/worker.ts`](src/worker.ts), the `/crash` route.
  `this.ctx.abort()` and nothing else.
- **The honest "nobody is coming" signal** — [`src/naive.ts`](src/naive.ts),
  the `#looping` field and the `frozen` flag derived from it. It is an instance
  field, so it is `false` on every fresh isolate.

## Deploying

The worker is `demlik-checkout-saga`, with both Durable Object classes declared
as `new_sqlite_classes` (SQLite-backed DOs, which is what the Workers free tier
supports).

```sh
npx wrangler deploy
```

If you have `wrangler dev` state from before the SQLite migration change, delete
`.wrangler/` first — local state remembers the old storage backend and miniflare
will refuse to start against a changed one.

## Notes

- tea is imported by relative path from `../../src`, not from the published
  package, so the example always compiles against the working tree. The root
  `package.json` `exports` point at `dist`, which is why this is the pragmatic
  route for an in-repo example.
- The fake payment provider is deterministic in the attempt number, and that
  number travels in the Cmd from reducer State — never a module-level counter.
  A counter would reset when the isolate dies, so the resumed order would sail
  through on its first post-crash charge and the demo would be a lie.
