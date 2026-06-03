# Pattern 09 — Anti-Patterns (What Breaks TEA)

Each anti-pattern maps to a specific invariant violation. If you see one of
these in code, name the invariant it violates and the architecture you actually
have.

## Anti-pattern 1: Side effects inside update

**Violates:** Invariant 1 (purity of the transition)

```typescript
// WRONG — update performs I/O
function update(msg: Msg, state: Model): [Model, Cmd[]] {
  switch (msg.type) {
    case "Submit":
      fetch("/api/submit", { method: "POST", body: JSON.stringify(state.form) })
      return [{ ...state, submitted: true }, []]
  }
}
```

**What you actually have:** A controller with global side effects.

**Fix:** Return a Cmd description instead:

```typescript
// CORRECT — update describes the effect
case "Submit":
  return [state, [{ type: "submit_form", data: state.form }]]
```

## Anti-pattern 2: Closures as Cmds

**Violates:** Invariant 2 (effects are data, not closures)

```typescript
// WRONG — Cmd is a closure that captures state
return [state, [{
  type: "run_effect",
  execute: async () => {
    await fetch("/api", { body: JSON.stringify(state) })
  },
}]]
```

**What you actually have:** A callback-style reducer. Tests need fakes
for every external collaborator. You can't serialize, replay, or log
the effect.

**Fix:** Make the Cmd a plain data object:

```typescript
// CORRECT — Cmd is serializable data
return [state, [{ type: "submit_form", data: state.form }]]
```

## Anti-pattern 3: Multiple dispatch paths

**Violates:** Invariant 3 (one interpreter owns all I/O)

```typescript
// WRONG — side effects in two places
// In the interpreter:
interpret.fetch_data = async (cmd) => {
  const data = await fetch(cmd.url)
  await analyticsService.track("data_fetched")  // side-channel!
  return { type: "DataFetched", data }
}

// ALSO wrong — setTimeout outside the machine
setTimeout(() => dispatch({ type: "Timeout" }), 5000)  // rogue dispatch
```

**What you actually have:** Redux + thunks + sagas — four mental models
for one thing.

**Fix:** Every side effect goes through the interpreter or subscribe. Analytics
tracking should be its own Cmd:

```typescript
case "DataFetched":
  return [
    { ...state, data: msg.data },
    [{ type: "track_analytics", event: "data_fetched" }],
  ]
```

## Anti-pattern 4: Two Msg unions

**Violates:** Invariant 4 (one Msg union for the whole machine)

```typescript
// WRONG — two separate event types
type UserMsg = { type: "Click" } | { type: "Submit" }
type SystemMsg = { type: "Timeout" } | { type: "DataLoaded" }

function update(msg: UserMsg | SystemMsg, state) { ... }
```

**What you actually have:** A bus. There's no single place to read the contract.

**Fix:** One union:

```typescript
type Msg =
  | { type: "Click" }
  | { type: "Submit" }
  | { type: "Timeout" }
  | { type: "DataLoaded" }
```

## Anti-pattern 5: Mutating state

**Violates:** Implicit invariant (immutability)

```typescript
// WRONG — mutation
case "AddItem":
  state.items.push(msg.item)  // mutation!
  return [state, []]
```

**What you actually have:** Shared mutable state. Replay doesn't work
because each replay mutates the same object.

**Fix:** New object every transition:

```typescript
case "AddItem":
  return [{ ...state, items: [...state.items, msg.item] }, []]
```

## Anti-pattern 6: Await inside update

**Violates:** Invariant 1 (purity)

```typescript
// WRONG — async update
async function update(msg, state) {
  case "LoadData":
    const data = await fetch("/api/data")
    return [{ ...state, data }, []]
}
```

**What you actually have:** An async controller. The update function is no
longer a pure, synchronous transition. Other Msgs can arrive while the await
is pending, creating race conditions.

**Fix:** Return a Cmd:

```typescript
case "LoadData":
  return [{ ...state, phase: "loading" }, [{ type: "fetch_data" }]]
```

## Anti-pattern 7: Non-deterministic Sub identity

```typescript
// WRONG — id uses random value
subscriptions: (state) => [
  { type: "timer", id: Math.random().toString() },
]
```

**What you actually have:** A subscription that restarts on every state change
because the runtime sees a new identity each time.

**Fix:** Deterministic id:

```typescript
subscriptions: (state) => [
  { type: "timer", id: "heartbeat-timer" },
]
```

## Anti-pattern 8: Derived state in Model

```typescript
// WRONG — storing derived data
type Model = {
  items: Item[]
  itemCount: number  // derived from items.length
  isValid: boolean   // derived from form fields
}
```

**Fix:** Derive in view, not in model:

```typescript
type Model = { items: Item[] }

// Derive when needed
const itemCount = state.items.length
```

## Quick diagnostic

| You see this... | It violates... | You actually have... |
|----------------|---------------|---------------------|
| `fetch()` inside update | Invariant 1 | Controller |
| `() => Promise<void>` in Cmd | Invariant 2 | Callback reducer |
| Side effects in two places | Invariant 3 | Shattered interpreter |
| Two Msg types composed with `\|` | Invariant 4 | Bus |
| `.push()` / `.splice()` on state | Immutability | Mutable state |
| `async update` | Invariant 1 | Async controller |
| `id: Math.random()` on Sub | Identity | Thrashing subs |
