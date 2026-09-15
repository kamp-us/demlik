# Coexisting with Cloudflare's `agents` SDK

Cloudflare's [`agents`](https://www.npmjs.com/package/agents) SDK is how most
people write a Durable Object today. It is a base class you extend, and it
already owns several of the DO resources `@demlik/tea/do` reaches for: the
`alarm()` handler, a state cell, a queue, and a set of SQLite tables named
`cf_agents_*`.

So the obvious read of `@demlik/tea/do` from inside an `agents` subclass is:
*this wants to own the alarm, and something else already does — I cannot use
it.* That read is wrong, and this page says exactly why, resource by resource.
It also says the part that is true: **one** part of `/do` really does want to be
the runtime, and if you are already running another loop you cannot adopt that
part incrementally.

Everything below was checked against `agents@0.16.2`.

## The short answer

| Resource | `agents` owns | `/do` wants | Verdict |
| --- | --- | --- | --- |
| `alarm()` + `cf_agents_schedules` | yes, exclusively | an `AlarmStorage` port | **compose** — back the port with the SDK's scheduler |
| `cf_agents_state` via `setState` | yes | `doStore` over `ctx.storage` | **sit beside** — different jobs, different cells |
| the step/tool loop | only if you use its loop | `createAgentHost` wants it | **pick one** — this is the all-or-nothing line |
| dedup of external writes | nothing | `idempotentEffect` | **drop in** — no shared resource at all |

## The alarm

A Durable Object has exactly one alarm, and the SDK claims it. Every
`schedule()` call writes a row into `cf_agents_schedules` and then recomputes
`ctx.storage.setAlarm(...)` from the earliest row in that table. The SDK's
`alarm()` handler reads the table back and dispatches to your named callback.

That is why writing `ctx.storage.setAlarm(...)` yourself does not work inside an
`agents` subclass: your deadline holds only until the SDK's next `schedule()`
call, which overwrites the alarm with whatever its own table says is next. You
have not raced the SDK; you have simply been overwritten.

`durableTimer` never asks for the raw alarm. Its `alarm` field is
`AlarmStorage` — a one-method structural interface:

```ts
interface AlarmStorage {
  setAlarm(scheduledTime: number): void | Promise<void>;
}
```

A real `DurableObjectStorage` satisfies it structurally, which is why the plain
Worker examples pass `ctx.storage` directly. But *anything* with that method
satisfies it, so inside an `agents` subclass you satisfy it with the SDK's own
scheduler:

```ts
const TIMER_CALLBACK = "onTeaTimer";

class AuditAgent extends Agent<Env, State> {
  private readonly alarmPort: AlarmStorage = {
    setAlarm: async (atMs: number) => {
      // The SDK inserts a NEW row per schedule() call, so clear ours first.
      for (const s of await this.listSchedules()) {
        if (s.callback === TIMER_CALLBACK) await this.cancelSchedule(s.id);
      }
      await this.schedule(new Date(atMs), TIMER_CALLBACK);
    },
  };

  private readonly timer = durableTimer({
    alarm: this.alarmPort,
    nextDeadline: () => this.computeDeadline(),
    onFire: () => this.dispatchTick(),
  });

  // The SDK's alarm() dispatches here; durableTimer fires, then re-arms.
  async onTeaTimer() {
    await this.timer.onAlarm();
  }
}
```

Your `alarm()` stays the SDK's. `durableTimer` keeps owning the part it was
written to own — compute-next-deadline, idle when `nextDeadline()` returns
`null`, and re-arm off post-fire state so a cold wake resumes the schedule a
never-evicted instance would have held.

### Two rough edges, stated plainly

**Absolute versus relative, and the second boundary.** `AlarmStorage.setAlarm`
takes an *absolute* epoch-ms instant. The SDK's `schedule(when, …)` takes
`Date | number | string`, where a `Date` is absolute, a `number` is a delay in
*seconds*, and a string is a cron expression. Pass the `Date` — converting to a
relative delay adds a `Date.now()` read that the absolute form does not need.

Either way you lose sub-second precision: the SDK stores the deadline as whole
epoch seconds, computed with `Math.floor`. Because it floors rather than
rounds, a deadline lands **up to 999 ms early**, never late. For a give-up
timeout or a heartbeat that is invisible. For a sub-second game tick it is not,
and that grain should stay on the raw alarm rather than on this adapter.

**`rearm()` is idempotent on the raw alarm and is not idempotent here.**
`durableTimer.rearm()` is documented as safe to call repeatedly, because on the
DO alarm API arming the same target twice is a harmless overwrite. On the SDK it
is not: each `schedule()` for a `Date` inserts a new row, so a timer that
re-arms on every transition accumulates rows in `cf_agents_schedules` and fires
its callback once per stale row. Hence the cancel sweep in the adapter above.

The SDK's `idempotent: true` option is not the fix. For a `Date` schedule it
matches on callback plus payload and *ignores the time*, so it returns the
existing row and your new deadline is silently dropped — which is the opposite
of what a re-arming timer needs.

## The state cell

`setState` writes a single row in `cf_agents_state` and broadcasts the new value
to every connected client. It is a **view** cell: synchronous, client-facing, no
deserialization boundary.

`doStore` is a persistence boundary. It requires a `parse: (raw: unknown) => S | null`
precisely because bytes coming back out of storage are `unknown`, and returning
`null` from `parse` is the defined "no usable persisted state" path that boots
your machine fresh instead of handing `update` a value that is typed as the new
`S` but holds the old one.

So they do not compete, and `doStore` does not replace `cf_agents_state`:

- **`doStore` owns the Model.** It writes its own key in `ctx.storage` (default
  `@@state`), untouched by the SDK. It is what survives a schema change across a
  deploy, because it has a parse seam and `cf_agents_state` has none.
- **`setState` owns what clients see.** Mirror a projection of the Model into it
  when a transition lands, and the SDK's client-state sync keeps working.

Putting the Model in `cf_agents_state` instead costs you the boundary parse and
broadcasts your whole internal state to every connected client. Neither is a
trade worth making to save one storage key.

## The loop — the all-or-nothing line

This is the part where the concern is real.

`createAgentHost` is documented as *"the runtime cell + the SSE hub + the
framework test seam, owned ONCE"*, and it means it. It builds the machine, wraps
it in `run(...)`, wires `agentEvents()` into an SSE hub, runs `autoBoot`, and
hands back the lifecycle surface. There is no seam in it for a loop you are
already running. If your DO drives LangGraph, or any other orchestrator, you
cannot adopt `createAgentHost` for part of the run — it either owns the loop or
it does not run.

`sseFromAgentEvents` is on the same side of the line for the same reason: it
subscribes to a `@demlik/tea` runtime's `AgentEvent` stream, so it presupposes
that runtime exists.

**`stepHost` and `runStepLoop` are not.** This is the correction most likely to
change what you adopt. `stepHost` orchestrates a `StepEngine` — a four-method
port *you* implement:

```ts
interface StepEngine<R, I, O> {
  tokenFor(runId: string): Promise<string | null> | string | null;
  resume(runId: string, posted: StepResult<R>): Promise<void> | void;
  nextStep(runId: string): Promise<NextStep<I> | null> | NextStep<I> | null;
  terminalOutput(runId: string): Promise<O> | O;
}
```

Nothing in that port names a `@demlik/tea` runtime, and `step-host.ts` imports
nothing from `../agent`. Implement those four methods against whatever loop you
already have and you get the `/step` contract — constant-time token check,
re-armed give-up alarm, idempotent settle of a re-POSTed result, hibernation
between steps — without moving your orchestrator.

### The adoptability table

| Export | Adoptable incrementally? | Why |
| --- | --- | --- |
| `durableTimer`, `AlarmStorage` | yes | injected alarm port; adapter above |
| `doStore`, `doEventSourcedStore` | yes | its own storage key, independent of the SDK |
| `idempotentEffect`, `appliedEffects`, `foldApplied`, `emptyApplied`, `isApplied`, `applyAppliedEvent` | yes | pure folds plus a guard; no runtime, no storage |
| `pendingEffectsLedger`, `foldLedger`, `survivingEffects`, `emptyLedger`, `applyEffectEvent` | yes | same — pure folds over events you persist |
| `constantTimeEqual`, `mintRunToken` | yes | standalone helpers |
| `stepHost`, `runStepLoop` | yes | drives a `StepEngine` you implement |
| `broadcastFrame`, `acceptPresenceSocket`, `registerHibernatableSocket`, `presenceCount` | yes | take the socket set as input |
| `sseHub` | yes | a generic fan-out hub over any event type `E` |
| `bootResume`, `agentIsResumable` | partly | `bootResume` needs a `BootingRuntime`; `agentIsResumable` is a pure predicate over an `AgentState` |
| `sseProjection`, `driveProjections`, `runProjection` | partly | fold over a `(Model, Msg)` transition stream — yours to supply, but it must be one |
| `reissueSurvivingEffects` | no | reads a `DurableCommandCarrier` built by the gateway |
| `deferredGateway`, `durableDeferredGateway`, `durableCommandCarrier` | no | the gateway *is* the transport for a `/do`-hosted agent |
| `createAgentHost`, `autoBoot`, `sseFromAgentEvents` | no | these want to be the runtime |

The rule underneath the table: an export is incrementally adoptable when
everything impure arrives as an injected port, and it is all-or-nothing when it
reaches for a `@demlik/tea` `Runtime` or the gateway that feeds one. That is the
same seam-versus-assembly split the rest of the package is built on — see
[ADR 0002](../../.decisions/0002-do-host-layer.md).

## Where to start

If you are on the `agents` SDK today and want the smallest useful step: take
`idempotentEffect` plus `appliedEffects` for your external writes. They are pure
folds with no storage and no runtime, so they compose with anything, and they
replace the dedup table most DO agents end up hand-rolling.

The alarm adapter is the next one, and `stepHost` after that if your control
plane is a cold-between-steps pull loop.

## Not answered here

Whether `/do` should ship a first-party `agents`-SDK adapter — a built-in
`AlarmStorage` implementation, a `setState` mirror — is a separate and larger
question. This page describes what composes today with no new code in the
package.
