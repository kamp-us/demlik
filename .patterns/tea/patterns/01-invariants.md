# Pattern 01 — The Four Invariants

These four invariants define TEA. Drop any one and you have a different architecture.
The test is sequential: fail at invariant 1, stop — name what you have instead.

## The invariants

| # | Invariant | One-line rule |
|---|-----------|---------------|
| 1 | **Purity of the transition** | `update` has no I/O, no clock, no random, no `await` inside. |
| 2 | **Effects are data, not closures** | A Cmd is a tagged value describing intent, not a function that already started running. |
| 3 | **One interpreter owns all I/O** | Every effect goes through one place — the runtime — that translates effect-data into real-world calls. |
| 4 | **One Msg union for the whole machine** | Every event that can move the system has a name and a payload, in one auditable type. |

## What each invariant is load-bearing for

### Invariant 1 — Purity

Without it you lose: replay, time-travel, deterministic tests, reasoning about
a transition without booting the world. The entire testability story is built
on this single fact.

**Source:** Elm guide — `update : Msg -> Model -> Model` (sandbox) and
`update : Msg -> Model -> (Model, Cmd Msg)` (element). Neither signature
permits `Task`, `IO`, or `Promise`. The function takes values and returns values.

### Invariant 2 — Effects are data

Without it you lose: serializability → no time-travel, no durable replay,
no logging-as-spec. You also re-couple the producer to the executor — the
reducer now needs to know HOW to do HTTP, not just that an HTTP should happen.

**Source:** Elm guide Random example — `Random.generate NewFace (Random.int 1 6)`
is a *description* of what to generate, not the generation itself. The guide says:
"We are not actually generating the values yet. We are just describing _how_
to generate them."

**Source:** `elm/core/src/Platform/Cmd.elm` — "Elm has **managed effects**, meaning
that things like HTTP requests or writing to disk are all treated as *data* in Elm."

### Invariant 3 — One interpreter

Without it, async sneaks in at random call sites. The interpreter is what makes
the system a *system* instead of a pile of reducers.

**Source:** Elm guide Commands and Subscriptions intro — "our programs will also
send `Cmd` and `Sub` values to the runtime system." The runtime is singular. There
is one runtime that receives all Cmds and all Subs.

**Proof:** raj's entire runtime is one function. The single line `effect(dispatch)`
is the interpreter — it receives inert effect-data from the reducer, performs the
real-world act, and loops produced events back into the same `dispatch`.

### Invariant 4 — One Msg union

Without it you have a bus — there is no single place to read the contract.
If you let two unions in (say "events" plus "side-channel actions"), you have
reintroduced the second path that "One Way to Do Each Thing" exists to delete.

**Source:** Every Elm guide example defines exactly one `type Msg` per module.
The compiler enforces exhaustive matching on this union in `update`.

## The diagnostic test

Ask each invariant in order. The moment one fails, name what you have:

| Failed invariant | What you actually have |
|-----------------|----------------------|
| 1 (impure update) | A **controller** with global side effects |
| 2 (effect closures) | A **callback-style reducer**; tests need fakes for every collaborator |
| 3 (interpreter shattered) | **Redux + thunks + sagas + observables**; four mental models for one thing |
| 4 (multiple unions) | A **bus**; no single place to read the contract |

## In TypeScript

```typescript
// Invariant 1: update is pure — pattern-match on Msg, return [State, Cmd[]]
function update(msg: Msg, state: Model): [Model, Cmd[]] {
  switch (msg.type) {
    case "Roll":
      return [state, [{ type: "generate_random", max: 6 }]]
    case "NewFace":
      return [{ dieFace: msg.face }, []]
  }
}

// Invariant 2: Cmds are tagged data — serializable, inspectable, testable
type Cmd =
  | { type: "fetch_book" }
  | { type: "generate_random"; max: number }

// Invariant 3: One interpreter — one record mapping Cmd types to real-world handlers
const interpret = {
  fetch_book: (cmd) => fetch(url).then(r => r.text()),
  generate_random: (cmd) => Math.floor(Math.random() * cmd.max) + 1,
}

// Invariant 4: One Msg union — every event in one auditable type
type Msg =
  | { type: "Roll" }
  | { type: "NewFace"; face: number }
  | { type: "GotText"; result: Result<string, Error> }
```
