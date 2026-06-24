# The reentrancy deadlock — A→B→A on a non-reentrant grain

Because a non-reentrant activation processes one request at a time and stays busy across every
`await`, a call chain that loops back to a grain still executing an earlier turn cannot make progress:
the grain is awaiting downstream work, the downstream work is (transitively) awaiting *that grain*,
and neither side can advance. This is the canonical Orleans reentrancy deadlock. It is not a bug in
the scheduler — it is the direct consequence of the single-writer guarantee — and the fix is never to
issue, from inside a turn, a call that re-enters the same grain unless reentrancy is explicitly
enabled. (Conceptual gloss for a state-fold reducer: a reducer that inline-`await`s a result which
depends on the same reducer running again is the exact shape Orleans serializes against — a pure,
synchronous reducer that returns and lets the next message run cannot construct this cycle.)

## How it manifests

Grain A is non-reentrant and is running request R1. Inside R1 it `await`s a call to B; B (in the
same chain) calls back to A. A cannot accept that call: R1 is still the `_blockingRequest`, so
`MayInvokeRequest` returns `false` for the re-entrant message, which queues forever. R1 is blocked
awaiting B, B is blocked awaiting A, and A is blocked on its own queue. The activation never returns.

```csharp
// A is non-reentrant. This deadlocks: R1 holds A busy while awaiting B, and B re-enters A,
// whose re-entrant call queues behind R1 — which is waiting on B. Nothing completes.
public class AGrain : Grain, IAGrain
{
    public async Task R1()
    {
        var b = GrainFactory.GetGrain<IBGrain>(0);
        await b.CallBackIntoA(this.GetPrimaryKey());  // B will call IAGrain.R2 on THIS activation
    }
    public Task R2() => Task.CompletedTask;           // queues forever behind R1
}
```

The runtime does not hang silently forever in practice: a watchdog notices the activation has been
holding one request too long and tears it down as "likely stuck."

```csharp
// DeactivateStuckActivation — the runtime's diagnosis of the hang.
private void DeactivateStuckActivation()
{
    IsStuckProcessingMessage = true;
    var msg = $"Activation {this} has been processing request {_blockingRequest} since {_busyDuration} and is likely stuck.";
    Deactivate(new DeactivationReason(DeactivationReasonCode.ActivationUnresponsive, msg));
    // "...if the grain was deemed stuck then there is probably some kind of
    //  application bug, perhaps a deadlock."
    UnregisterMessageTarget();
}
```

## Approaches

### Don't re-enter from inside a turn (the default rule)

**When to use:** Always, for non-reentrant grains. Structure call graphs so a grain never, within a
running request, issues a call that transitively comes back to itself. This keeps the single-writer
guarantee and avoids the hang entirely.

**Pattern:**

```csharp
// Safe: A computes a value and hands it to B; B does NOT call back into A within this chain.
public async Task R1()
{
    var data = ComputeLocally();
    await GrainFactory.GetGrain<IBGrain>(0).Consume(data);  // no edge back to A
}
```

**Gotchas:**
- The cycle can be indirect: A→B→C→A deadlocks the same way. The rule is about the *transitive* call
  graph, not just direct self-calls.
- A self-call (A calling another method on its own grain reference) is the degenerate case and
  deadlocks immediately on a non-reentrant grain.
- An `[AlwaysInterleave]` or `[ReadOnly]` re-entrant call is admitted by the gate and does *not*
  deadlock — but only because it skips the blocker, with the interleaving hazard that implies.

### Scope reentrancy to the chain (`AllowCallChainReentrancy`)

**When to use:** The re-entrant call is intentional and you want it admitted without making the whole
grain reentrant. Open a call-chain reentrancy section before issuing the outbound call; the returning
call carries a matching reentrancy id and `MayInvokeRequest` admits it via its `IsReentrantSection`
branch.

**Pattern:**

```csharp
// The downstream call is tagged with a reentrancy id; when it loops back to A, A admits it
// instead of queueing it behind R1. The window closes when the section is disposed.
public async Task R1()
{
    using (RequestContext.AllowCallChainReentrancy())
    {
        await GrainFactory.GetGrain<IBGrain>(0).CallBackIntoA(this.GetPrimaryKey());
    }
}
```

**Gotchas:**
- Only calls carrying the *active* id are admitted; an unrelated concurrent request to A still queues,
  so this is far narrower than `[Reentrant]`.
- The re-entrant turn now interleaves with the suspended R1 — any state both touch is subject to the
  stale-read hazard. The deadlock is gone, but you have opted into interleaving for that state.
- `SuppressCallChainReentrancy()` does the inverse inside an otherwise-reentrant context, restoring
  serial behavior for a scope.

### Make the grain reentrant (last resort)

**When to use:** Only when the grain holds no cross-request invariant, so global interleaving is
genuinely safe. `[Reentrant]` installs an always-true interleave predicate, so a re-entrant call is
never blocked and the cycle cannot form.

**Pattern:**

```csharp
// Every request to A may interleave, so the re-entrant call is admitted immediately — no deadlock.
// Justified ONLY because A holds no invariant a concurrent turn could break.
[Reentrant]
public class AGrain : Grain, IAGrain { /* ... */ }
```

**Gotchas:**
- This removes the deadlock *and* the single-writer guarantee for the entire grain, not just the
  re-entrant path. Every `await` in every method is now an interleaving point.
- Reaching for `[Reentrant]` to fix a hang you do not understand converts a loud, observable deadlock
  into silent state corruption — strictly worse.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Any non-reentrant grain | Don't issue a re-entrant call from inside a turn | Keeps single-writer; the cycle can't form |
| Intentional A→B→A in one chain | `AllowCallChainReentrancy()` scope | Admits the returning call by id; narrowest opt-in |
| Grain has no shared invariant | `[Reentrant]` on the class | Re-entrant call never blocks; accept full interleaving |
| Re-entrant call only reads | `[ReadOnly]` on the method | Admitted when both are read-only; no write race |
| Need serial inside a reentrant grain | `SuppressCallChainReentrancy()` scope | Restores one-at-a-time for that window |

## Rules

- On a non-reentrant grain, a request that, while running, awaits a call that transitively re-enters
  the same activation deadlocks — the runtime eventually deactivates it as "likely stuck."
- The deadlock is a property of the call *graph*, not the syntax: A→B→A, A→B→C→A, and a direct
  self-call all hang identically.
- The default discipline is: do not, from inside a running turn, issue a call that comes back to this
  grain. A pure, synchronous handler that returns before the next message runs cannot build the cycle.
- To intentionally admit a re-entrant call, prefer `AllowCallChainReentrancy()` (scoped, id-matched)
  over `[Reentrant]` (whole-grain) — it removes the deadlock with the smallest interleaving surface.
- Any escape hatch that admits the re-entrant call also interleaves it with the suspended outer turn;
  re-validate shared state after each `await`.
- Waiting on a grain's own deactivation from inside that grain is itself a deadlock — the same
  busy-awaiting-self shape.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Awaiting a call that loops back to a non-reentrant grain | The returning call queues behind the running request, which is waiting on it — permanent hang |
| A non-reentrant grain calling a method on its own reference | Degenerate self-cycle; deadlocks immediately |
| Slapping `[Reentrant]` on a stateful grain to clear a hang | Replaces a visible deadlock with silent races on shared state |
| Assuming the deadlock surfaces as a clear error | It surfaces as an unresponsive activation the watchdog tears down, not a synchronous failure |
| Using `[AlwaysInterleave]` to dodge the cycle on stateful methods | The re-entrant write now races the suspended write it re-entered |
| Awaiting self-deactivation from within the grain | Busy-awaiting-self; the deactivation never completes |

## See also

- [reentrancy.md](./reentrancy.md) — the serial gate (`MayInvokeRequest`/`_blockingRequest`) this deadlock falls out of, and every opt-in in full
- [durable-effects.md](./durable-effects.md) — outbound effects also flow one-at-a-time through the single-writer activation
- [recovery.md](./recovery.md) — the replay-time analogue of single-writer serialization
