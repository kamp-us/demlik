# Reentrancy — one request at a time, and opting out of it

A grain activation in Orleans is a virtual actor that, by default, processes **one request at a
time**. The runtime never invokes a second request on an activation while the first is still
executing — including across an `await` inside that first request. This serial discipline is what
lets grain code read and mutate its own fields without locks: there is only ever one logical thread
of execution touching the state, so a turn never races another turn. This concern covers the gate
the message pump uses to decide whether a queued request may run now, and the three escape hatches —
`[Reentrant]`, `[AlwaysInterleave]`/`[ReadOnly]`, and `[MayInterleave]` plus call-chain reentrancy —
that relax it, each reintroducing the shared-state hazard the default removed. (Conceptual gloss for
a state-fold reducer: "one request at a time, even across `await`" is exactly "the reducer is the
single writer and runs to completion before the next message" — a reducer that returns a Promise
and is awaited inline breaks that guarantee.)

## The serial gate

The activation keeps a set of running requests and a single `_blockingRequest`. The pump calls
`MayInvokeRequest` for each queued message; only messages that pass may start. The default answer for
a busy non-reentrant grain is **no** — the message waits.

```csharp
// ActivationData.MayInvokeRequest — the whole reentrancy decision, top to bottom.
bool MayInvokeRequest(Message incoming)
{
    if (!IsCurrentlyExecuting) return true;            // idle: anything may run
    if (incoming.IsAlwaysInterleave) return true;      // [AlwaysInterleave] always runs
    if (_blockingRequest is null) return true;         // nothing is holding the activation
    if (_blockingRequest.IsReadOnly && incoming.IsReadOnly) return true;  // [ReadOnly] ∥ [ReadOnly]
    if (incoming.GetReentrancyId() is Guid id && IsReentrantSection(id)) return true;  // call-chain
    if (GetComponent<GrainCanInterleave>() is GrainCanInterleave canInterleave)        // [Reentrant]/[MayInterleave]
        return canInterleave.MayInterleave(GrainInstance, incoming)
            || canInterleave.MayInterleave(GrainInstance, _blockingRequest);
    return false;                                       // default: queue it, run it later
}
```

`_blockingRequest` is what makes the grain serial: the first non-interleavable request to run becomes
the blocker, and nothing else runs until it clears.

```csharp
// RecordRunning — only a non-interleavable request, run while nothing else blocks, becomes the blocker.
void RecordRunning(Message message, bool isInterleavable)
{
    _runningRequests.Add(message, CoarseStopwatch.StartNew());
    if (_blockingRequest != null || isInterleavable) return;
    // This logic only works for non-reentrant activations.
    _blockingRequest = message;
}
// ResetRunning clears _blockingRequest when that same request completes, releasing the gate.
```

## Approaches

### Non-reentrant by default (the serial mailbox)

**When to use:** Always, unless you have measured a specific need and understood the hazard. This is
the default with no attribute. State is touched by one turn at a time, so no field needs a lock and no
interleaving can corrupt an invariant mid-update.

**Pattern:**

```csharp
// No concurrency attribute → non-reentrant. The runtime serializes every request to this activation,
// including across awaits, so `_count` is single-writer and needs no synchronization.
public class CounterGrain : Grain, ICounterGrain
{
    private int _count;
    public Task<int> Increment() { _count++; return Task.FromResult(_count); }
}
```

**Gotchas:**
- Serialization holds *across `await`*: while request A is awaiting an outbound call, the activation
  is still busy and will not start request B. Long awaits inside a turn stall every other caller.
- One slow or hung request blocks the whole activation; the runtime treats a request that never
  returns as a likely deadlock (see `reentrancy-deadlock.md`).
- The guarantee is per-activation. A `[StatelessWorker]` grain has many activations, so the
  single-writer property does *not* hold across the logical grain.

### Per-request interleaving: `[ReadOnly]` and `[AlwaysInterleave]`

**When to use:** A specific method is safe to run concurrently with others. `[ReadOnly]` marks a
method that does not mutate state — two read-only requests may overlap. `[AlwaysInterleave]` marks a
method that may interleave with *any* request, including writes; use it only for genuinely
independent work (status pings, cancellation).

**Pattern:**

```csharp
// Attributes go on the grain INTERFACE method, not the implementation.
public interface IInventoryGrain : IGrainWithStringKey
{
    [ReadOnly] Task<int> GetStock();              // interleaves with other [ReadOnly] calls
    [AlwaysInterleave] Task Ping();               // interleaves with everything, even writes
    Task Reserve(int quantity);                   // ordinary write: serial, becomes the blocker
}
```

**Gotchas:**
- `[ReadOnly]` two-way: it only interleaves when *both* the running blocker and the incoming request
  are read-only (`_blockingRequest.IsReadOnly && incoming.IsReadOnly`). A read-only request still
  waits behind a running write.
- `[AlwaysInterleave]` runs even while a write is mid-flight — it must not depend on any invariant a
  concurrent write could be in the middle of breaking.
- The attribute must sit on the interface method. The Orleans analyzer raises an error
  (`[AlwaysInterleave] must only be used on the grain interface method and not the grain class
  method`) if placed on the implementation.

### Whole-grain interleaving: `[Reentrant]` and `[MayInterleave]`

**When to use:** The grain holds no cross-request invariant that an interleaved turn could violate —
e.g. a stateless coordinator, or state partitioned so concurrent turns never touch the same slot.
`[Reentrant]` makes every request to the grain interleavable. `[MayInterleave]` lets a static
predicate decide per request.

**Pattern:**

```csharp
// [Reentrant] installs a predicate that returns true for every request — the grain never blocks.
[Reentrant]
public class StatelessCoordinatorGrain : Grain, ICoordinatorGrain { /* ... */ }

// [MayInterleave] names a static bool predicate over the incoming request.
[MayInterleave(nameof(MayInterleave))]
public class SelectiveGrain : Grain, ISelectiveGrain
{
    public static bool MayInterleave(IInvokable req) => req.GetMethodName() == "Query";
}
```

The runtime turns `[Reentrant]` into an always-true interleave predicate:

```csharp
// ReentrantPredicate, installed for any grain whose Reentrant property is set.
internal class ReentrantPredicate : IMayInterleavePredicate
{
    public bool Invoke(object _, IInvokable bodyObject) => true;  // every request may interleave
}
```

**Gotchas:**
- Reentrancy reintroduces the race the serial mailbox removed: two turns now interleave at every
  `await`, so a field read before an `await` may be stale after it. Shared mutable state needs
  re-checking after each suspension point, or the grain must hold no such invariant at all.
- `[MayInterleave]`'s callback must be `public static bool Name(IInvokable req)`; a wrong signature
  throws at activation. The predicate is consulted for *both* the incoming request and the running
  blocker.
- `[Reentrant]` is documented as an advanced feature — "should not be used unless the implications
  are fully understood."

### Call-chain reentrancy (`AllowCallChainReentrancy`)

**When to use:** A non-reentrant grain needs to tolerate a re-entrant call that comes back to it
*within the same logical call chain* (A → B → A) without globally turning on interleaving. Opt in for
the duration of a scope; the runtime tags outgoing calls with a reentrancy id and admits a returning
call that carries an active id.

**Pattern:**

```csharp
// While the section is open, calls issued downstream carry a reentrancy id; a request that returns
// to this activation bearing an active id is admitted instead of deadlocking.
using (RequestContext.AllowCallChainReentrancy())
{
    await otherGrain.DoWorkThatCallsMeBack(this.GetPrimaryKey());
}
// Disposing the section ends the window. SuppressCallChainReentrancy() does the inverse.
```

This is the `IsReentrantSection(id)` branch of `MayInvokeRequest`: the incoming request's reentrancy
id is checked against the activation's active sections.

**Gotchas:**
- The window is scoped to the `using` block; calls issued after disposal are serial again.
- It admits only calls in the *same* chain (matching id) — unrelated concurrent requests still queue,
  so the blast radius is narrower than `[Reentrant]`.
- The re-entrant turn still interleaves with the suspended outer turn, so the same stale-read hazard
  applies for any state both turns touch.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Default; state has cross-request invariants | No attribute (non-reentrant) | One turn at a time; single-writer, no locks |
| One method only reads state | `[ReadOnly]` on the interface method | Interleaves with other reads; still waits behind a write |
| One method is wholly independent | `[AlwaysInterleave]` on the interface method | Runs even alongside a write; for pings/cancellation |
| Grain holds no shared invariant | `[Reentrant]` on the class | Every request interleaves; max throughput |
| Interleave only specific requests | `[MayInterleave(predicate)]` on the class | Static predicate decides per request |
| Tolerate A→B→A within one chain | `RequestContext.AllowCallChainReentrancy()` | Admits the returning call by reentrancy id, scoped to the `using` |

## Rules

- A non-reentrant activation processes exactly one request at a time, and that serialization holds
  across every `await` inside the request — the activation stays busy until the turn returns.
- The single-writer property is what removes the need for locks; do not add interleaving to a grain
  whose state has an invariant a concurrent turn could observe mid-update.
- `[ReadOnly]`, `[AlwaysInterleave]`, and `[OneWay]` are per-request markers and belong on the grain
  **interface** method; `[Reentrant]` and `[MayInterleave]` are whole-grain markers and belong on the
  **class**.
- `[ReadOnly]` interleaves only when both the running blocker and the incoming request are read-only.
- A `[MayInterleave]` predicate must be `public static bool Name(IInvokable req)`; it is evaluated for
  both the incoming request and the current blocker.
- Once interleaving is enabled, treat every `await` as a point where another turn may have run: any
  state read before the `await` must be re-validated after it.
- Prefer the narrowest opt-in that solves the problem: call-chain reentrancy over `[Reentrant]`,
  `[ReadOnly]` over `[AlwaysInterleave]`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Adding `[Reentrant]` to silence a deadlock without auditing state | Trades a visible hang for silent corruption; interleaved turns now race the same fields |
| Putting `[AlwaysInterleave]`/`[ReadOnly]` on the grain class method | Orleans analyzer error ORLEANS0001; the marker is honored only on the interface |
| Mutating state inside a `[ReadOnly]` method | Two read-only turns interleave assuming neither writes; one that writes corrupts the other |
| Holding a long `await` inside a non-reentrant turn | The activation is busy the whole time; every other caller is stalled behind it |
| Leaving `[MayInterleave]` predicate non-static or wrong-signature | Throws at activation; the grain cannot start |
| Treating `[StatelessWorker]` state as single-writer | Many activations exist; the per-activation guarantee does not span the logical grain |

## See also

- [reentrancy-deadlock.md](./reentrancy-deadlock.md) — the A→B→A cycle on a non-reentrant grain, why it hangs, and the rule it implies
- [durable-effects.md](./durable-effects.md) — the same single-writer activation drives one effect at a time through its outbound ledger
- [recovery.md](./recovery.md) — replay folds events through one writer; the serial discipline is the live-time analogue
