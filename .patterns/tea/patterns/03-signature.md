# Pattern 03 — Why `(Model, Cmd Msg)` Is the Minimum Signature

The return type of `update` is not a convention — it is a packing statement.

## The claim

```
update : Msg -> Model -> (Model, Cmd Msg)
```

`(Model, Cmd Msg)` is one returned value, not two. The reducer must decide, in a
single atomic step, **both the next state AND the next intent** — and ship them
together. You cannot return state and "kick off an effect" on the side. You cannot
return state and decide effects later. You return the pair or you cannot return at all.

## What the pair buys

| Property | Why it works |
|----------|-------------|
| **Atomicity** | State and intent move together. No window where one is updated and the other isn't. |
| **Replayability** | A log of `(Msg, (Model, Cmd Msg))` triples is a complete spec. Diff the Cmds to see what the program *would have done*. |
| **Composition** | Parent reducers map child `(SubModel, Cmd SubMsg)` into `(Model, Cmd Msg)` by lifting both halves under product. |
| **Testability** | A test asserts on `(Model, Cmd Msg)` — both halves equally first-class. Effects don't run; you assert *that they would have been issued*. |

## What you get if you drop the pair

| Signature | What it is | What you lose |
|-----------|-----------|--------------|
| `(state, msg) → state` | A **reducer** (Redux) | No effect intent — effects happen out-of-band, untestable from the reducer |
| `(state, msg) → Promise<state>` | A **controller** | Purity — the function now performs I/O, can't replay or time-travel |
| `(state, msg) → state` + middleware | **Redux + thunks** | Atomicity — state and effects are decided in different places |

## Proof from Elm source

`Browser.sandbox` looks like it doesn't return a pair:

```elm
sandbox : { init : model, update : msg -> model -> model, view : model -> Html msg }
```

But the implementation wraps it:

```elm
sandbox impl =
  Elm.Kernel.Browser.element
    { init = \() -> ( impl.init, Cmd.none )
    , update = \msg model -> ( impl.update msg model, Cmd.none )
    , subscriptions = \_ -> Sub.none
    }
```

Even sandbox is secretly `(Model, Cmd Msg)`. The pair is always there.

## Proof from raj

raj's `update` returns `[state, effect]`:

```javascript
function change (change) {
  state = change[0]      // the state half
  var effect = change[1]  // the effect half
  if (effect) {
    effect(dispatch)      // interpreter runs the effect
  }
  view(state, dispatch)
}
```

The pair is the minimum. raj can't express TEA without it.

## Testing consequence — replay

Because the pair is always returned, you can replay the full state + effect
history without ever touching the runtime:

```typescript
// Conceptual replay — no runtime, no interpreter
function replay(init, update, msgs) {
  let [state, cmds] = init()
  const allCmds = [...cmds]

  for (const msg of msgs) {
    const [next, newCmds] = update(msg, state)
    state = next
    allCmds.push(...newCmds)
  }

  return { state, cmds: allCmds }
}

// Assert on state
expect(result.state).toEqual({ dieFace: 1 }) // unchanged — Roll issues a Cmd

// Assert on effects — they never ran, you assert on the description
expect(result.cmds).toEqual([{ type: "generate_random", max: 6 }])
```

The test never boots a runtime. It never calls interpret. It asserts on the
*description* of what would have happened. This is only possible because the
pair is always there.

## One-line restatement

"Next state AND next intent, in one atomic value, every transition." That's the signature.
