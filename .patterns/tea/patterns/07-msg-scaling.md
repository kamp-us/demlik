# Pattern 07 — When the Msg Union Becomes a Liability

## The reframe

The Msg union is not throughput — it is **identity**. Every Msg variant is a
named cause. The union is the contract surface: the complete, auditable list
of "things that can happen to this machine." That's the value.

The price is that the union grows. When it grows past the point where a human
can hold it in working memory, the contract surface becomes a tariff.

## When the union earns its keep

The positive case — when the Msg union is doing real work:

1. **Exhaustive matching** — the compiler tells you when a new cause exists
   that you haven't handled
2. **Replay** — a log of Msgs is a complete description of what happened
3. **Audit** — security review reads one union to see every entry point
4. **Testing** — replay exercises every path through the same contract

## The tax — what specifically degrades

### Cognitive — "where does this apply?"

A 30-variant Msg union means the reader must scan 30 cases to find the one
that matters. Even with TypeScript narrowing, the switch statement becomes
a wall of text.

### Reducer-table density

Every Msg must be handled in every state. In a machine with 5 states and 30
Msgs, the transition table has 150 cells. Most are no-ops — the message
doesn't apply in that state. The no-op cells are noise that obscures the
signal cells.

### TypeScript-specific tax

- **Union width** — TypeScript performance degrades on unions >25 members.
  The TypeScript Performance wiki explicitly says: "Preferring Base Types
  Over Unions" for large discriminated unions.
- **No exhaustiveness sugar** — Elm's `case` is exhaustive by default. TS
  needs `assertNever` in the default branch, which is a discipline cost.
- **Discriminator verbosity** — `{ type: "FetchBookResult"; result: ... }`
  is more characters than Elm's `GotText (Result ...)`.

Source: https://github.com/microsoft/TypeScript/wiki/Performance#preferring-base-types-over-unions

## The inflection point — operational definition

You have hit the inflection point when:

1. **More than 50% of transition cells are no-ops** — the machine has phases,
   and most Msgs don't apply in most phases.
2. **The Msg union is wider than 20 variants** — the compiler slows down, and
   no human can hold the full contract in working memory.
3. **You find yourself grouping Msgs by prefix** — `LoginSubmit`, `LoginError`,
   `LoginSuccess` want to be their own sub-machine.

When any of these are true, apply a composition strategy.

## Five composition strategies

They are all the same move: split the Msg space into smaller unions and
compose them. The difference is where the split happens.

### 1. Nested TEA / Sub-machine (Elm canon)

The child has its own `Model`, `Msg`, `Cmd`. The parent forwards Msgs to the
child and lifts child commands into parent commands.

```typescript
// Parent Msg includes a child-forwarding variant
type ParentMsg =
  | { type: "LoginMsg"; msg: LoginMsg }
  | { type: "DashboardMsg"; msg: DashboardMsg }
  | { type: "AppLevelThing" }

// Parent update delegates
function update(msg: ParentMsg, state: AppState): [AppState, Cmd[]] {
  switch (msg.type) {
    case "LoginMsg": {
      const [loginState, loginCmds] = loginUpdate(msg.msg, state.login)
      return [{ ...state, login: loginState }, loginCmds.map(liftToParent)]
    }
    // ...
  }
}
```

This is the Elm-canonical approach. Richard Feldman's "Scaling Elm Apps" (Elm
Europe 2017) demonstrates it with `elm-spa-example`.

Source: https://www.youtube.com/watch?v=DoA4Txr4GUs
Source: https://github.com/rtfeldman/elm-spa-example

### 2. OutMsg pattern

The child returns `[State, Cmd[], OutMsg?]` — an optional message for the parent.
The parent reads OutMsg and decides what to do. The child never dispatches to the
parent directly.

```typescript
type LoginOutMsg = { type: "LoginSucceeded"; user: User }

function loginUpdate(msg, state): [LoginState, Cmd[], LoginOutMsg | null] {
  // ... returns outMsg when login succeeds
}

// Parent reads it
const [loginState, loginCmds, outMsg] = loginUpdate(msg, state.login)
if (outMsg?.type === "LoginSucceeded") {
  return [{ ...state, user: outMsg.user, phase: "dashboard" }, []]
}
```

### 3. Translator pattern

The parent provides a translator function that maps child Msgs to parent Msgs.
The child doesn't know the parent's Msg type.

### 4. Routing (page-level dispatch)

The top-level machine is a router. Each page is its own machine. The router
forwards Msgs to the active page and ignores Msgs for inactive pages.

### 5. Phase-keyed dispatch

When state is a discriminated union with distinct phases (`Loading | Ready | Error`),
key the update function by phase. Each phase cell only sees Msgs relevant to
that phase.

```typescript
// Instead of one big switch on msg.type across all states,
// dispatch by state phase first, then msg type
const update = {
  Loading: {
    GotData: (state, msg) => [{ type: "Ready", data: msg.data }, []],
    GotError: (state, msg) => [{ type: "Error", error: msg.error }, []],
    // other msgs are no-ops in Loading
  },
  Ready: {
    Refresh: (state, msg) => [{ type: "Loading" }, [{ type: "fetch_data" }]],
    // ...
  },
  Error: {
    Retry: (state, msg) => [{ type: "Loading" }, [{ type: "fetch_data" }]],
  },
}
```

## Does XState solve this?

XState's hierarchical states solve **half** the problem: the half about
reducer-table density (nested states partition the transition table).

XState's hierarchy does **NOT** solve: the Msg union still exists as the
event type. Hierarchy partitions which transitions fire, but doesn't
partition the type. You still have one `EventObject` union.

Sharper claim: XState trades the Msg-union tax for a state-hierarchy tax.
The transition table gets sparser, but the state tree gets deeper. The
complexity moves, it doesn't disappear.

Source: https://stately.ai/docs/parent-states
