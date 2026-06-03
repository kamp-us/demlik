# Pattern 04 — Effects as Data

## The rule

From `elm/core/src/Platform/Cmd.elm`:

> Elm has **managed effects**, meaning that things like HTTP requests or writing
> to disk are all treated as *data* in Elm. When this data is given to the Elm
> runtime system, it can do some "query optimization" before actually performing
> the effect. Perhaps unexpectedly, this managed effects idea is the heart of
> why Elm is so nice for testing, reuse, reproducibility, etc.

Effects in TEA are **descriptions**, not **executions**. The reducer produces inert
data that says "I want X to happen." The interpreter receives that data and makes
it happen. The reducer never sees the real world.

## Cmd — one-shot effects

A Cmd says "do this once, report back with a Msg."

### In Elm

```elm
-- This is NOT generating a random number.
-- It is describing that a random number should be generated.
Random.generate NewFace (Random.int 1 6)

-- This is NOT making an HTTP request.
-- It is describing that an HTTP request should be made.
Http.get { url = "...", expect = Http.expectString GotText }
```

The Elm guide says:
"We are not actually generating the values yet. We are just describing
_how_ to generate them."

### In TypeScript

Cmds are discriminated unions. The reducer returns them; the interpreter
executes them.

```typescript
// The reducer describes WHAT should happen
type Cmd =
  | { type: "fetch_book"; url: string }
  | { type: "generate_random"; max: number }
  | { type: "save_to_storage"; key: string; value: string }

function update(msg: Msg, state: Model): [Model, Cmd[]] {
  switch (msg.type) {
    case "Roll":
      // Don't generate a random number. Describe that one should be generated.
      return [state, [{ type: "generate_random", max: 6 }]]
    case "NewFace":
      return [{ dieFace: msg.face }, []]
  }
}

// The interpreter maps descriptions to real-world execution
const interpret = {
  fetch_book: async (cmd) => {
    const text = await fetch(cmd.url).then(r => r.text())
    return { type: "GotText", result: { ok: true, value: text } }
  },
  generate_random: async (cmd) => {
    return { type: "NewFace", face: Math.floor(Math.random() * cmd.max) + 1 }
  },
  save_to_storage: async (cmd) => {
    localStorage.setItem(cmd.key, cmd.value)
    // fire-and-forget — no Msg returned
  },
}
```

Each interpreter handler returns a Msg to feed back into update (or void for
fire-and-forget).

### In raj

raj's effect is a function that receives `dispatch`:

```javascript
function update(msg, state) {
  return [
    state,
    function effect(dispatch) {
      fetch('/api/data')
        .then(r => r.json())
        .then(data => dispatch({ type: 'GotData', data }))
    }
  ]
}
```

raj's effects are functions, not data — this is the tradeoff raj makes for
simplicity. Elm and TypeScript implementations use tagged data for
serializability and testability.

## Sub — ongoing subscriptions

A Sub says "keep watching this thing, send me Msgs when something happens."

### In Elm

```elm
-- Subscribe to clock ticks every second
subscriptions : Model -> Sub Msg
subscriptions model =
  Time.every 1000 Tick
```

From `elm/core/src/Platform/Sub.elm`:

> "A subscription is a way of telling Elm, 'Hey, let me know if anything
> interesting happens over there!' The cool thing here is that this means
> *Elm* manages all the details of subscriptions instead of *you*. So if a
> web socket goes down, *you* do not need to manually reconnect with an
> exponential backoff strategy, *Elm* does this all for you behind the scenes!"

Key: `subscriptions` is a **function of Model**. Subs can change based on state.
The runtime diffs the sub list on every state change and starts/stops accordingly.

### In TypeScript

Subs need an identity so the runtime can diff them across transitions.

```typescript
type Sub =
  | { type: "every_second"; id: string }
  | { type: "listen_websocket"; id: string; url: string }

function subscriptions(state: Model): Sub[] {
  const subs: Sub[] = []

  // Always tick
  subs.push({ type: "every_second", id: "clock" })

  // Only listen to WS when connected
  if (state.phase === "connected") {
    subs.push({
      type: "listen_websocket",
      id: `ws-${state.url}`,
      url: state.url,
    })
  }

  return subs
}

// Each Sub type maps to a start function that returns a cleanup function
const subscribe = {
  every_second: (sub, dispatch) => {
    const id = setInterval(() => dispatch({ type: "Tick", time: Date.now() }), 1000)
    return () => clearInterval(id)
  },
  listen_websocket: (sub, dispatch) => {
    const ws = new WebSocket(sub.url)
    ws.onmessage = (e) => dispatch({ type: "WsMessage", data: e.data })
    return () => ws.close()
  },
}
```

The runtime manages lifecycle:
- Same id present in old + new → leave running
- Id removed → call cleanup
- New id → call subscribe handler, store cleanup function

## The contract

1. Reducers describe effects as data → never perform I/O
2. Interpreters execute effects → return a Msg (or void for fire-and-forget)
3. Subscribers manage lifecycles → return a cleanup function
4. The runtime owns the loop: update → interpret/subscribe → dispatch → update
