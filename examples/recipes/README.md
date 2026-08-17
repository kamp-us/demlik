# tea recipes — the day-scale shapes

> The sibling [`examples/checkout-saga`](../checkout-saga) referenced throughout
> lands with the Effect demo branch; the recipes here stand on their own and need
> nothing from it to run.

The checkout-saga demo exists to be watched: it compresses a
multi-day order lifecycle into about thirty seconds so you can kill the isolate
mid-refund and see the refund still complete. This collection is the other half
of that argument. These five recipes are the same substrate at its real time
scale — an agent run paused four days on a human's approval, a dunning ladder
spread over three weeks, an expense report escalating after seven days of
silence. None of them can be demoed live, and that is exactly the point: a
process you cannot hold open is a process whose waits have to be **data**.

Every recipe is one directory: a pure `machine.ts` (state, msgs, cmds, reducer),
sometimes a `handlers.ts` when the external calls are central to the story, and a
test suite. Each suite includes a **resume-from-serialized-state** test — the
mid-process state is written to JSON, a *second* runtime is booted from those
bytes, and the process is driven to completion on the fresh runtime. That test is
the collection's thesis; the rest is scaffolding around it.

## The one convention that makes all of this testable

**No recipe ever sleeps.** A machine that waits writes the instant its wait ends
into state — `dueAt`, `nextRetryAt`, `assignedAt + REMIND_AFTER_MS` — and the
host arms exactly one alarm for it. A `tick` Msg carries `now` in its payload and
the reducer compares that against the stored deadline. So:

- The reducer is a pure function of `(state, msg)`. No clock read, no RNG, no
  timer handle. It can be replayed, property-tested, and diffed.
- Tests drive weeks of wall-clock in microseconds by dispatching ticks with
  fabricated timestamps (`await rt.dispatch({ type: "tick", at: FOURTEEN_DAYS })`).
  Nothing is mocked and no fake timers are installed, because there was never a
  real timer to fake.
- A duplicate or early tick is a no-op by construction (`if (state.dueAt === null
  || msg.at < state.dueAt) return [state, []]`), which matters because a Durable
  Object alarm can genuinely fire twice across a cold wake.

The clock is read exactly once per effect, at the handler boundary, and travels
into the reducer on the Msg.

## Running them

```sh
pnpm test:recipes       # 28 tests, five suites
pnpm typecheck:recipes  # typecheck, tests included
```

---

## 1. `durable-agent-run/` — an AI agent loop with a budget and a human gate

An agent works a goal over several provider calls. It has a spend cap, its
provider returns 529s, and some steps propose an action a human must bless before
it happens. `running → awaiting-approval → running → done | failed`.

The recipe's whole reason to exist is that **both waits are the same shape, and
one of them has no timer at all**. The retry wait is `nextRetryAt`: a number, so
a redeploy mid-backoff still owes attempt 3 at T. The approval wait sets
`pendingApproval` and schedules *nothing* — the run resumes only when an
`approval_granted` Msg arrives, which the test does four days later. No fiber
waits four days. A row does.

```ts
interface State {
  readonly phase: "idle" | "running" | "awaiting-approval" | "done" | "failed";
  readonly step: number;        // steps COMPLETED; the one in flight is step + 1
  readonly spentUsd: number;    // the ledger — the cap is a pure read of it
  readonly budgetUsd: number;
  readonly attempt: number;     // provider attempts for the step in flight
  readonly nextRetryAt: number | null;
  readonly pendingApproval: { step: number; action: string; askedAt: number } | null;
  readonly transcript: readonly string[];
  readonly failure: string | null;
}
```

Uses: `defineMachine` / `Reducer` from `@demlik/tea`; `backoffDelay` +
`RetryPolicy` from `@demlik/tea/retry-backoff`; **the Effect bridge** —
`toInterpret` + `teaServices` from `@demlik/tea/effect`, with the provider's
typed `ProviderUnavailable` folded into a `step_failed` Msg by `catchTag` inside
the effect (`E = never` is the bridge's rule and also the right model: an
overloaded provider is a transition, not an exception).

Hosting: one Durable Object per run, keyed by `runId`. `nextRetryAt` → alarm.
Approval arrives as an HTTP `POST /runs/:id/approve` that the DO turns into an
`approval_granted` dispatch; because there is no alarm armed during the wait, an
idle DO costs nothing while a human takes a week.

## 2. `dunning/` — a failed subscription payment, over three weeks

A card is declined. Billing retries on day 1, day 3 and day 7; all three failing
opens a 14-day grace window; then the account is downgraded. A payment landing at
any point — a retry succeeding, or the customer fixing their card in the portal —
ends everything as `recovered`.

Day-scale timers cannot live in a process, so this one is arithmetic: every
deadline in the 21-day ladder derives from `firstFailedAt + RETRY_OFFSETS_MS[rung]`,
and one `dueAt` field is the only thing the host arms an alarm for.

```ts
interface State {
  readonly phase: "idle" | "retrying" | "grace" | "downgraded" | "recovered";
  readonly firstFailedAt: number;   // the anchor every deadline derives from
  readonly rung: number;            // which of [1d, 3d, 7d] is next
  readonly dueAt: number | null;    // the ONE instant the host arms an alarm for
  readonly declines: readonly { at: number; reason: string }[];
  readonly outcomeAt: number | null;
}
```

Uses: `defineMachine` / `Reducer` only. The `charge` / `notify` / `downgrade`
Cmds go through a recording `Interpret` in the tests — a real deployment would
author them with `toInterpret` exactly like recipe 1.

Hosting: one DO per subscription, `dueAt` → alarm. Note that the 14-day grace
alarm is a single scheduled wake two weeks out, not 14 daily polls.

## 3. `approval-chain/` — expense approval as an audit log

An expense report walks an ordered list of approvers. Each gets the request, a
reminder after two days of silence, an escalation to their manager after seven.
Any rejection kills it; the last approval carries it.

State **is** the audit log. `decisions` and `notices` are append-only arrays with
timestamps living in the same row the machine runs on, so "who approved this,
when, and what did we chase them with" is a read, not a join against an events
table a failed write can desynchronise. Out-of-order decisions are ignored rather
than accepted, because silently recording a later approver's yes would forge that
log.

```ts
interface State {
  readonly phase: "draft" | "pending" | "approved" | "rejected";
  readonly approvers: readonly string[];
  readonly cursor: number;             // whose desk it is on
  readonly assignedAt: number | null;  // both chase deadlines derive from this
  readonly remindedAt: number | null;
  readonly escalatedAt: number | null;
  readonly dueAt: number | null;
  readonly decisions: readonly { approver: string; verdict: Verdict; at: number; comment: string | null }[];
  readonly notices: readonly { approver: string; kind: "assigned" | "reminded" | "escalated"; at: number }[];
}
```

Uses: `defineMachine` / `Reducer` only — no bridge, no battery. The interesting
part is entirely pure, which is the point worth making about this shape.

Hosting: one DO per request. `dueAt` → alarm; approvers hit an HTTP route that
dispatches `decide`. Escalation is a Cmd, so routing it (Slack, PagerDuty, the
manager's inbox) is a handler concern the reducer never learns about.

## 4. `onboarding-drip/` — a per-user lifecycle you can cancel

Day 1 welcome, day 3 tip, day 7 check-in. The moment the user does the thing the
drip is nudging them toward, everything still owed is cancelled.

Cancellation here is the deletion of a number. There is no queued job to find and
revoke, no scheduler row to chase — `dueAt` becomes `null` and the drip is over.
Contrast the usual shape, where three delayed jobs are enqueued up front and each
one has to re-check "is this user still eligible?" against a database that may
disagree with whatever its payload said when it was written.

```ts
interface State {
  readonly phase: "idle" | "scheduled" | "completed";
  readonly startedAt: number;       // every send deadline derives from enrollment
  readonly cursor: number;          // next step in DRIP
  readonly sent: readonly { template: string; at: number }[];
  readonly dueAt: number | null;    // null == cancelled, and that IS the cancel
  readonly endedBy: "finished" | "activity" | null;
  readonly cancelledBy: { what: string; at: number } | null;
}
```

Uses: `defineMachine` / `Reducer`. Sends are fire-and-forget Cmds with no
follow-up Msg, which makes the whole machine a pure schedule walker.

Hosting: one DO per enrolled user, `dueAt` → alarm, `send_email` handler talking
to your provider. Product activity events (from a queue, a webhook, your
analytics pipeline) dispatch `user_active`.

## 5. `fleet-reconcile/` — desired vs reported device config

An operator sets a desired config; the device reports what it is actually
running. When they differ, push; when a push fails, back off; when the device
reports back matching, converge.

Reconcile is a loop, and a loop that survives has to be re-entrant from state
alone. Nothing remembers "I was halfway through a push" — `desiredRev` /
`inFlightRev` / `attempt` / `dueAt` say it all, so any wake-up recomputes what is
owed. That is also what makes a mid-push config change safe: the operator bumps
`desiredRev`, the in-flight push's outcome arrives stamped with the *old* rev,
and the reducer discards it and re-pushes instead of converging on a config
nobody wants any more.

```ts
interface State {
  readonly phase: "unknown" | "pushing" | "awaiting-report" | "backoff" | "converged";
  readonly desired: DeviceConfig | null;
  readonly reported: DeviceConfig | null;
  readonly desiredRev: number;         // bumped per operator change, stamped on each push
  readonly inFlightRev: number | null;
  readonly attempt: number;            // consecutive failures → the backoff curve
  readonly dueAt: number | null;
  readonly lastError: string | null;
}
```

Uses: `defineMachine` / `Reducer`; `backoffDelay` from
`@demlik/tea/retry-backoff`.

**On reusing `@demlik/tea/reconciler`** — worth saying plainly, since it is the
obvious question. The reconciler battery is the right tool one level *up*: it
owns a paginated scan of the whole actual world (it embeds a `paginated-walk`
slice), a diff into a `Change[]` plan, and a TTL applied-ledger via `cache` so a
resumed apply skips changes already made. Its unit of work is a **fleet-wide
sweep**. This recipe's unit of work is **one device** with one config blob and no
plan to page through, so embedding it would have meant configuring a scan with a
single-page cursor to produce a one-element diff — more machinery, less clarity,
and a worse teaching example. The honest reuse is the backoff curve, which the
recipe does take from `retry-backoff` (the same primitive the reconciler's own
gate uses), so the two agree on retry shape without sharing a lifecycle. If your
real problem is "converge a whole fleet", use the battery; this recipe is the
per-entity shape it would be composed from.

Hosting: one DO per device, keyed by device id. `dueAt` → alarm. `set_desired`
arrives from the control plane, `reported` from the device's own heartbeat. A
fleet-wide rollout is then N of these plus a `reconciler` pass above them — the
per-device durability is not the coordinator's problem.

---

## Wiring, for when you copy one of these

The recipes are library examples: no worker, no wrangler, no `package.json` of
their own. They carry a `vitest.config.ts` (the repo root config scopes itself to
`src/**`) and a `tsconfig.json` that, unlike the root's, *includes* the test
files. The shared `harness.ts` is two things: a `Store<S>` that round-trips
through `JSON.stringify` exactly like `doStore` does — so "resume" means
re-parsing bytes, never sharing an object — and a recording `Interpret` for the
recipes whose Cmds are fire-and-forget.

For the real host wiring — a `DurableObject` with `doStore`, an `alarm()` handler
that dispatches the timer Msg, and a `ManagedRuntime` built once per instance
from an Effect `Layer` — read
[`examples/checkout-saga/src/worker.ts`](../checkout-saga/src/worker.ts). Every
recipe here drops into that shape unchanged: swap the machine, keep the alarm
plumbing.
