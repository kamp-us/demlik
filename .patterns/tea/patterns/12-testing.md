# Pattern 12 — Testing TEA Programs

## The principle

TEA programs are testable by construction. Because update is pure and effects
are data, you test by calling update and asserting on both halves of the
returned pair: the new state AND the effect descriptions.

You never boot a runtime in unit tests. You never mock the interpreter.
You assert on what the reducer *said should happen*, not on what actually happened.

## The replay pattern

Thread `init` + a sequence of Msgs through `update`. Collect all state
transitions and all emitted Cmds. Assert on the final state and the
cumulative Cmd list.

```typescript
function replay(program, msgs) {
  let [state, cmds] = program.init()
  const allCmds = [...cmds]

  for (const msg of msgs) {
    const [next, newCmds] = program.update(msg, state)
    state = next
    allCmds.push(...newCmds)
  }

  const subs = program.subscriptions?.(state) ?? []
  return { state, cmds: allCmds, subs }
}
```

This is the TEA testing primitive. Everything else builds on it.

## What to assert

### 1. Final state

"After these events, the model looks like this."

```typescript
const result = replay(program, [
  { type: "NameChanged", value: "Alice" },
  { type: "EmailChanged", value: "alice@example.com" },
])

expect(result.state).toEqual({
  name: "Alice",
  email: "alice@example.com",
})
```

### 2. Emitted Cmds (effect descriptions)

"After this event, the program *would have* issued these commands."

```typescript
const result = replay(program, [
  { type: "Submit" },
])

expect(result.cmds).toContainEqual({
  type: "submit_form",
  data: { name: "Alice", email: "alice@example.com" },
})
```

The effects never execute. You assert on the description, not the execution.
This is the power of effects-as-data.

### 3. Active subscriptions

"In this state, the program wants to be notified about these things."

```typescript
const result = replay(program, [
  { type: "StartTimer" },
])

expect(result.subs).toContainEqual({
  type: "every_second",
  id: "heartbeat",
})
```

### 4. State transitions (step-by-step)

"After each event, assert on intermediate state."

```typescript
function step(update, state, msg) {
  const [next, cmds] = update(msg, state)
  return { state: next, cmds }
}

let s = { type: "Loading" }
const r1 = step(update, s, { type: "GotData", data: "hello" })
expect(r1.state).toEqual({ type: "Ready", data: "hello" })
expect(r1.cmds).toEqual([]) // no effects on success
```

## What NOT to test

### Don't test the interpreter

The interpreter is I/O. It calls `fetch`, reads `localStorage`, sets up
WebSocket connections. Test it separately with integration tests if needed.
Unit tests for a TEA machine should never touch the interpreter.

### Don't mock dispatch

In a real TEA runtime, dispatch feeds Msgs back into update. In tests,
you call update directly with the Msg you want to test. There's nothing
to mock.

### Don't test the runtime loop

The runtime (boot → dispatch → save → reconcile → interpret → notify)
is infrastructure. It's tested once in the runtime library. Your machine's
tests should not re-test it.

## The Elm precedent

In Elm, `update` is just a function. Testing it is:

```elm
test "increment" <|
  \_ ->
    let
      (newModel, cmd) = update Increment 0
    in
    Expect.equal newModel 1
```

No special test framework. No mocking. Call the function, check the output.
The pair `(newModel, cmd)` gives you everything: what changed and what would
happen next.

## From the Elm guide — Random example

```elm
update : Msg -> Model -> (Model, Cmd Msg)
update msg model =
  case msg of
    Roll ->
      ( model
      , Random.generate NewFace (Random.int 1 6)
      )
```

Testing this:

```elm
test "Roll issues a random generate command" <|
  \_ ->
    let
      (newModel, cmd) = update Roll { dieFace = 1 }
    in
    -- Model unchanged
    Expect.equal newModel { dieFace = 1 }
    -- Cmd is a Random.generate — you can't inspect Elm's opaque Cmd,
    -- but in TS with tagged Cmds, you CAN assert on it:
```

In TypeScript, because Cmds are plain data:

```typescript
const [state, cmds] = update({ type: "Roll" }, { dieFace: 1 })
expect(state).toEqual({ dieFace: 1 })  // unchanged
expect(cmds).toEqual([{ type: "generate_random", max: 6 }])  // the description
```

This is the testing advantage TypeScript has over Elm — Elm's `Cmd` is opaque
and not directly inspectable. TS discriminated-union Cmds are plain data you
can assert on directly.

## Decision table

| What you want to verify | How to test it |
|------------------------|----------------|
| State transition | Call `update(msg, state)`, assert on first element |
| Effect emission | Call `update(msg, state)`, assert on second element |
| Active subscriptions | Call `subscriptions(state)`, assert on result |
| Multi-step scenario | `replay(program, [msg1, msg2, ...])`, assert on final state + cumulative cmds |
| Interpreter correctness | Integration test — boot a real runtime, dispatch, observe results |
| Error handling | Pass error Msg (e.g. `GotText(Err NetworkError)`), assert on state transition |

## PBT vs example tests — when to reach for which

`packages/tea-pbt` provides property-based testing for TEA machines.
PBT generates random Msg sequences, folds them through the reducer, and
asserts a predicate over the resulting trace. It is a precise tool, and
it earns its keep — but only on the right kind of property. Reaching for
it on the wrong shape produces over-engineered tests that drift from the
reducer and surface as CI flakes (see `Binclusive/monorepo#1535`).

### The decision rule

Before writing a `*.pbt.test.ts`, answer two questions:

1. **Can you list every interesting input on a whiteboard in under
   5 minutes?** If yes → write example tests (`it.each` if you want
   them tidy). PBT's machinery (arbitraries, shrinking, 200 runs) is
   overhead for an enumerable space.
2. **Does the property have a meaningful claim beyond "for THIS input,
   the output is X"?** If no → it's an example, not a property.

You need both **(a) universal over a large space** and **(b) non-trivial
trace shape** for PBT to pay rent.

### Where PBT belongs

| Property class | Example | Why PBT, not examples |
|---|---|---|
| Trace-shape claims | "if final state is `done`, the trace contains a `ws:audit:done` Msg" (`reducer.audit-done.pbt.test.ts`) | claim is over **any path** through the machine — not a finite cell list |
| Msg X implies Cmd Y across any prefix | resume-handshake (`ws:client:hello` in `auditing` → `send_ws { client:ready }`) | universal over arbitrary sequences sharing a prefix |
| Reducer purity / determinism | `stubCtxThrowingProxy` + arbitrary (state, msg) — "no ctx reads, same input → same output" | random pairs surface accidental ctx reads or non-deterministic substrate calls |
| Roundtripping at boundaries | `parseBackgroundState(JSON.stringify(state)) === state` for any state arb | structured input space too large for examples |
| Algebraic laws | option / result / lens monad laws | universal by definition |

### Where PBT is the wrong tool

| Anti-pattern | Write instead |
|---|---|
| "this (state, msg) cell transitions to terminal" | example test against `machine.transition(state, msg, ctx)` — one `it` per cell |
| "this Msg flow renders this UI" | component test or E2E |
| "these N error codes are handled" | parameterized example (`it.each`) |

The tell is always the same: **input space is small and enumerable.**
If you can list it on a whiteboard, list it. The transition table IS
the spec.

### Smells inside PBT predicates

When you ARE writing PBT, these are the warning signs that your
property is in the wrong shape:

- **Carve-outs (`if (X) return true; // not a stuck-state test`).**
  An "...unless X" clause in a predicate almost always means you've
  stated the wrong property. Fix the shape, not the symptom. Carve-outs
  hide drift — they make the test pass for the wrong reasons.
- **Flat `Set<MsgType>` predicates over a discriminated union.**
  When terminality / cancellation / any cell semantic is involved, the
  fact is two-dimensional: `(state.type, msg.type) → behavior`. A flat
  set collapses one dimension and lets the reducer's actual table drift
  from the test's claim. Use `Partial<Record<StateType, Set<MsgType>>>`
  or convert to example tests.
- **`propertyTrace` with a final-state assertion when each step has
  a definite expectation.** `propertyTrace` is for "this Msg appeared
  somewhere before X" — a minority of real properties. If your claim
  is "in state S, msg M does Y," it's per-step → use `propertyInvariant`.
  Single-step claims fail on the first wrong cell with no shrinking
  past the bad step.
- **Two parallel representations of the same fact** (a `Set` / `Map`
  in the test that mirrors the reducer's table). Either delete one or
  add a structural agreement check — drift is a matter of time.

### Reference

`Binclusive/monorepo#1535` — flake from a flat `Set<MsgType>` over
two-dimensional cell semantics, plus `propertyTrace` with a carve-out
that softened the predicate enough to hide the drift on most seeds.
