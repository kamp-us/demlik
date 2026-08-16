# The brain/hand seam — untangling a codebase with TEA

The one structural move that turns a "huge, complex, messed-up" codebase into a
legible one: **separate the brain from the hands.** This doc is the worked recipe.
Its authority is ADR 0009 ("The brain/hand seam + strangler migration untangles a
codebase"), which is a repo-wide decision of the monorepo this package was
extracted from and stayed there; its reference implementation is that repo's
audit package.

## The idea in one picture

```
        COMPOSITION ROOT   (picks concrete adapters per environment; owns nothing)
                 |
                 v
        ┌────────────────────┐
        │   THE BRAIN         │   one pure `update: (State, Msg) => [State, Cmd[]]`
        │   read it = the     │   no IO, no throw, deterministic
        │   feature           │
        └───┬──────┬──────┬───┘
         Cmd│   Cmd│   Cmd│        every effect leaves as DATA (a Cmd)
            v      v      v
        ┌───────┐┌───────┐┌───────┐
        │ hand  ││ hand  ││ hand  │   PORTS — all IO, all vendor/client/OS specifics
        └───────┘└───────┘└───────┘
```

- **Brain** = the decision core. In `packages/audit` that is `src/update.ts`: the
  whole audit run reads top-to-bottom as `Idle → AwaitingHand → [Act → Reason →
  Record]* → Done | Failed`. It never calls a port — it only emits a `Cmd` (an
  effect described as data) and folds a `Msg` (a reply).
- **Hands** = adapters behind ports. In the audit system the ports are hands
  (drive the environment), reasoning (the AI judgment), findings (record), and a
  verifier (auth). Each is a small interface with N implementations — a real one, a
  stub. The brain cannot tell which it got.
- **Wiring** = the composition root (`src/run-audit.ts`) picks real-vs-stub per
  environment. That choice lives in exactly one file.

Concretely, in this monorepo: "brain" = the pure reducer *plus* the AI reasoning it
consults; "hands" = the clients (browser / screen-reader-VM / container) that act
and report what they perceived. **Multiple hand types, one brain.**

## Why the mess happens (and how the seam removes it)

Tangled code braids three things into one file: *decision logic*, *IO*, and
*client/vendor specifics*. Braided, every change ripples everywhere and nothing is
readable or testable in isolation. The seam un-braids them: the decision logic has
nowhere to hide IO (it can only emit a `Cmd`), the IO has nowhere to hide logic (an
adapter just fulfils a port), and client-specifics resolve *inside* one adapter
instead of leaking `if (vendor === …)` across the code. Size stops mattering;
the seam is what was missing.

## The extraction recipe (for existing, messy code)

Do this to **one** tangled module at a time — never the whole repo at once.

1. **Name the brain.** What are the *decisions*? Write them as `Msg` (inputs) →
   `update` → `Cmd` (effects as data) + next state. No IO in here yet — if you
   reach for a client, that is a `Cmd`, not a call.
2. **Name the hands.** Every place the old code did IO or touched a vendor/client
   becomes a **port** (a small interface) with a real adapter. Push all
   `clientType` / env / vendor branching *inside* the adapter.
3. **Stub every port first.** Prove the brain runs end-to-end against fakes (a
   replay test). This is the tracer — always runnable from here on.
4. **Swap one stub for a real adapter at a time.** Each real adapter is proven
   against the *same* brain.
5. **Parity-gate the cut-over.** Record current production behavior, replay the
   recorded input stream through the new brain, diff the observable output. Delete
   the old path only when parity passes. (Mechanism: `packages/audit/src/parity.ts`.)

## Rules

- The brain is **pure and synchronous**: `(State, Msg) => [State, Cmd[]]`. No IO,
  no `throw`, no `Date.now()`/random inside it — those make replay lie.
- Effects leave the brain as **data** (`Cmd`), interpreted by the composition root.
  The brain never imports an adapter.
- Every file is **brain, hand, or wiring** — never a blend. A reader can tell which
  by looking.
- `clientType` / vendor / env **resolves inside the adapter**. No hidden branch in
  the brain.
- Ports are **swappable**: a real adapter and a stub satisfy the same interface, so
  the tracer and production run the same brain.
- **One store** per fact; readers query a projection, never a second write path.

## Anti-patterns

| Anti-pattern | Why it's wrong | Instead |
|---|---|---|
| The reducer `await`s a client | IO in the brain — untestable, non-replayable | Emit a `Cmd`; the adapter does the IO |
| `if (vendor === "x")` in the core | client-specifics leaked into the brain | Resolve it inside the adapter behind the port |
| Big-bang rewrite of the messy module | too large; ships a rewrite-and-pray | Strangle: clean seam alongside, parity-gate, cut over |
| Swapping many stubs for real at once | you can't tell which adapter broke it | One seam in flight; prove each against the same brain |
| Homebrewing auth / retry / a store | reinventing a solved slot | Reinvention gate → copy Best-in-Slot (ADR 0009) |
| Storing the same fact in two places | dual source of truth drifts | Single store + a read projection |

## See also

- ADR 0009 — the decision this pattern serves. It is a decision of the monorepo
  this package came out of, not of this repo, so it is not in `.decisions/` here.
- [`durable-actors.md`](./durable-actors.md) — the TEA substrate the brain runs on (event-sourced virtual actors).
- [`tea-invariants.md`](./tea-invariants.md) — the purity/effects-as-data invariants the brain must hold.
- That monorepo's audit package — the end-to-end worked reference.
