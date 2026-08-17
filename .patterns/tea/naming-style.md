# TEA Naming Conventions

> This is a port of the Elm community's settled naming conventions to the
> `@demlik/tea` TypeScript substrate. The rules are not invented here — they
> come from the talks, gists, and style guides cited at the bottom. The
> substrate rules live in [`tea-invariants.md`](./tea-invariants.md) and the
> architecture port in [`elm-canon.md`](./elm-canon.md). This doc is the
> interface-design layer above them: what to *call* the State / Msg / Cmd /
> Sub variants the canon already defines.
>
> The convention is older than this repo. Erlang's `gen_server` call/cast
> (1986), Akka's ask/tell, Redux's `REQUEST/SUCCESS/FAILURE` triplet, and
> Elm's `Cmd Msg` carrying a constructor are the same idea rediscovered in
> four languages over four decades. We are inheriting, not inventing.

## The four naming positions

Every TEA machine has four discriminated unions to name (plus optional Port
and Store). The canon defines what each *is* — this doc gives style rules
for the variant names *inside* each.

| Position    | Canon reference                   | Style rule                                                       |
| ----------- | --------------------------------- | ---------------------------------------------------------------- |
| State variant | the 5 named pieces               | Way of being (noun / gerund-noun)                                |
| Msg variant   | canon §2.4                      | **Who** did **what** (and optionally **where/how**) — past tense |
| Cmd variant   | canon §2.4, Invariant 3         | Imperative verb-phrase; `into` carries the result Msg constructor |
| Sub variant   | canon §2.5, Invariant 4         | Source noun (lowercase short name; also the `SubId`)             |

All variant discriminator strings use **PascalCase**, except `Sub` variants
(which are also `SubId`s and stay lowercase). The reducer reads as a
state-machine table:

```ts
case "UserClickedSignInButton": ...     // not "user_clicked_sign_in_button"
```

## Msg — Who did What (and optionally Where/How)

A Msg names something that *happened*. Past tense. The canonical Elm
community framework (Noah Z. Gordon's talk, see Sources) says a Msg name
answers three questions in order:

| # | Question                | Answer becomes...                                                                              |
| - | ----------------------- | ---------------------------------------------------------------------------------------------- |
| 1 | **What happened?**      | Past-tense event verb: `Clicked`, `Hovered`, `Focused`, `Blurred`, `Pressed`, `Moved`, `Changed`, `Received`, `Failed`, `Succeeded`, `Created`, `Closed`, `Attached`, `Detached`, `Ticked` |
| 2 | **Who did it?**         | Actor: `User`, `Browser`, `Server`, `Brain` (our DO), `Chrome`, `Timer`, `Queue`, `WebApp`     |
| 3 | **Where / how?** (optional) | Specifier: `SignInButton`, `ModalCloseButton`, `FocusPill`, `AuditWindow`, `Heartbeat`     |

Result: `UserClickedSignInButton`, `BrainSentHello`, `ChromeOpenedAuditWindow`,
`TimerFiredHeartbeat`, `BrainConnectionErrored`.

### Actor is required

The actor (Question 2) goes **in the name** — always. Impersonal names
hide the causal story. `WindowCreated` is wrong because Chrome and the user
can both close windows in different paths; `ChromeOpenedAuditWindow` vs.
`UserClosedAuditWindow` keeps the cause visible to the reducer's reader.

### Multiple Msgs for the same effect is a feature, not duplication

The single all-purpose Msg (`Navigate`, `StartAudit`, `Submit`) is the
anti-pattern. Chadtech's gist (see Sources) names this directly:

> "If you have a `Msg` named `Navigate`, it's going to be the one `Msg`
> you use whenever you want to navigate. But if you are naming `Msg` as
> past-tense descriptions, then several different things could happen that
> could cause a navigation."

So `start_audit` correctly splits into:

```ts
| { type: "WebAppRequestedAuditStart"; ... }
| { type: "QueueRequestedAuditStart"; ... }
```

The reducer's transition body may be identical for both today. That's
fine. The Msgs differ because the *causes* differ, and the
`Transitions` table preserves the causal record. When the queue path
later needs a different cleanup behavior, the split is already there.

### No-op Msgs are valid

```ts
case "BrainDecoderFailed": return [state, []];     // ← perfectly fine
case "LogOutSucceeded":    return [state, []];
```

These are "a perfect record of what happened" (Chadtech). The Msg log is
the operator's window into the machine; a no-op Msg in the log tells the
operator the event was *observed and decided not actionable*, distinct
from *never arrived*.

### Anti-names

| Anti-name              | Why                                                                       |
| ---------------------- | ------------------------------------------------------------------------- |
| `Navigate`             | All-purpose verb — split into per-cause past-tense Msgs.                  |
| `StartAudit`           | Imperative, no actor — that's a Cmd. Try `WebAppRequestedAuditStart`.     |
| `OnBridgeConnect`      | `On-` is a handler prefix, not a Msg.                                     |
| `BridgeMsg`            | Tautology, says nothing.                                                  |
| `WsToolCallReceived`   | Transport prefix forbidden (see §"Wire vs machine"). Try `BrainRequestedToolCall`. |
| `WindowCreated`        | No actor — Chrome or user? Try `ChromeOpenedAuditWindow`.                 |

## Cmd — imperative; `into` carries the result Msg

A `Cmd` is a request the reducer issues to the runtime. Verb-first
PascalCase. The actor is implicit (the runtime); the recipient subsystem is
implicit in the verb (`AttachDebugger` → Chrome, `SendWs` → the WS Sub).

The reducer hears back about a Cmd's result **iff** the Cmd carries an
`into` field (canon §2.4, Elm guide HTTP examples). The presence or absence
of `into` IS the convention.

```ts
type BackgroundCmd =
  // With `into` — the Cmd promises a Msg back. Use when the result branches
  // (success → Msg A, failure → Msg B).
  | { type: "CreateAuditWindow"; url: string;
      into: (r: Result<WindowError, WindowOk>) => BackgroundMsg }

  // Without `into` — fire-and-forget. The handler returns void; the reducer
  // observes nothing about this Cmd's outcome.
  | { type: "FocusWindow"; windowId: number }
  | { type: "SendWs"; msg: ClientMessage }
  | { type: "AttachDebugger"; tabId: number };
```

### When to use `into`

| Cmd kind                                                   | Use `into`?                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Branches on result (success → Msg A, failure → Msg B)      | **Yes.** `into` declares the branching at the Cmd type, forcing both Msg variants to exist.            |
| Single-shape ack (always resolves to one Msg)              | **Optional.** Handler-return works; `into` is sugar that pulls the constructor up to the emit site.    |
| Fire-and-forget (no observation needed)                    | **No.** Handler returns `void`. The substrate (`Interpret<M, C, Ctx>`) makes this legal.               |

The "no lying names" rule: if a Cmd's handler returns `void`, don't name a
Msg variant pretending to be its ack — there is no ack. Conversely, if a
Cmd carries `into`, every branch of the `Result` must be a real Msg the
reducer handles.

### Anti-names

| Anti-name        | Why                                  |
| ---------------- | ------------------------------------ |
| `WindowOpener`   | Noun-ified — Cmd is a verb.          |
| `DoSendWs`       | `Do-` is filler.                     |
| `SendWsCmd`      | `…Cmd` is type-noise.                |
| `WindowOpened`   | Past tense — that's a Msg.           |
| `UserCreateWindow` | Cmds don't need actors — the issuer is the runtime. |

## State — ways of being

A `State` variant is a noun (or gerund-noun) describing what *is*. The
variant completes *"We are **X**."*

> "We are **Idle**." ✓  "We are **Auditing**." ✓  "We are **Connect**." ✗

Examples from a production audit-extension phase union:

```
Idle | CreatingWindow | Connecting | Initializing | Auditing | Done
```

| Anti-name         | Why                                  |
| ----------------- | ------------------------------------ |
| `Connect`         | Verb — sounds like a Cmd.            |
| `ConnectAction`   | `…Action` belongs to Msg/Cmd.        |
| `BridgeOpenState` | `…State` is tautology.               |

## Sub — sources

A `Sub` variant is a noun describing a stream. Completes
*"…is listening to the **X**."*

```
ws | recorder | heartbeat
```

Sub names are also identities (canon Invariant 7, branded `SubId`). Keep
**lowercase short names** — they match the substrate's `Sub<"ws">`
declaration and read naturally in topology tables like `subscriptions(state)`.

| Anti-name              | Why                                  |
| ---------------------- | ------------------------------------ |
| `SubscribeToRuntime`   | Verb — that's a Cmd.                 |
| `RuntimeSubscription`  | `…Subscription` is tautology.        |

## Wire vs machine vocabulary

The wire protocol (`client:hello`, `tool:call`, `audit:done`, `video:frame`)
is duplicated **verbatim** on both sides of the wire — the client's `protocol.ts` and
the server's. That duplication IS the
contract — neither side may rename without breaking the other. The wire
vocabulary is **shared and stable**.

Machine vocabulary (`BrainSentHello`, `BrainRequestedToolCall`) is **local
and renameable**. Each machine translates wire → past-tense PascalCase Msg
at its **boundary parse** (the Sub handler, e.g. `extension/lib/subs.ts`).

```ts
// subs.ts — the boundary parse
ws.onmessage = (e) => {
  const parsed = parseDOMessage(e.data);   // wire type: "client:hello"
  if (parsed === null) return;
  switch (parsed.type) {
    case "client:hello":  return dispatch({ type: "BrainSentHello", hello: parsed });
    case "tool:call":     return dispatch({ type: "BrainRequestedToolCall", call: parsed });
    case "audit:done":    return dispatch({ type: "BrainSignalledAuditDone" });
    default: absurd(parsed);
  }
};
```

Two layers, two vocabularies, one explicit translation. The boundary parse
is the only file that knows both names — the rest of the reducer reads
only the past-tense PascalCase form.

### What this forbids

| Forbidden                                  | Why                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `WsToolCallReceived` (transport `Ws…`)     | The transport is the Sub's concern; the reducer sees the *fact*, not the wire.    |
| `WsClosed` / `WsErrored`                   | Same. Also collides with `WindowClosed`. Use `BrainConnectionClosed`.              |
| `Window/Created` / `Connection/Opened`     | Namespace prefixes leak structure that belongs to the fact's actor + verb.        |
| Renaming the wire types in `protocol.ts`   | The wire is the contract with the audit-agents side. Rename in the boundary parse instead. |

## Worked example

From a production extension's `events.ts`. The full rename:

```ts
// Before — wire-mirror dialect + snake_case + no actors
type BackgroundMsg =
  | { type: "start_audit"; ... }
  | { type: "stop_audit" }
  | { type: "window_created"; tabId: number; windowId: number }
  | { type: "window:closed" }
  | { type: "ws:open" }
  | { type: "ws:client:hello"; hello: HelloMessage }
  | { type: "ws:tool:call"; call: ToolCallMessage }
  | { type: "ws:audit:done" }
  | { type: "ws:close"; code: number }
  | { type: "ws:error"; error: string; at: number }
  | { type: "focus_window_requested" }
  | { type: "close_window_requested" }
  | { type: "open_results_requested" }
  | { type: "heartbeat_tick" };

// After — Elm convention (3-question framework, PascalCase, actor-in-name)
type BackgroundMsg =
  | { type: "WebAppRequestedAuditStart"; ... }
  | { type: "QueueRequestedAuditStart"; ... }              // split: different cause, same body
  | { type: "WebAppRequestedAuditStop" }
  | { type: "ChromeOpenedAuditWindow"; tabId: number; windowId: number }
  | { type: "UserClosedAuditWindow" }
  | { type: "BrainConnectionOpened" }
  | { type: "BrainSentHello"; hello: HelloMessage }
  | { type: "BrainRequestedToolCall"; call: ToolCallMessage }
  | { type: "BrainSignalledAuditDone" }
  | { type: "BrainConnectionClosed"; code: number }
  | { type: "BrainConnectionErrored"; error: string; at: number }
  | { type: "UserClickedFocusPill" }
  | { type: "UserClickedClosePill" }
  | { type: "UserClickedViewResultsPill" }
  | { type: "TimerFiredHeartbeat" };
```

The `Transitions` table reads as a sentence per cell:

```ts
const update: Transitions<BackgroundState, BackgroundMsg, BackgroundCmd> = {
  Auditing: {
    BrainRequestedToolCall:  (s, msg) => [s, [{ type: "ForwardTool", tabId: s.tabId, msg: msg.call }]],
    BrainSignalledAuditDone: (s)      => [toDone(s), [/* ... */]],
    BrainConnectionErrored:  (s, msg) => [{ ...s, connection: { type: "degraded", lastError: msg.error, degradedAt: msg.at } }, []],
    TimerFiredHeartbeat:     (s)      => [s, [{ type: "SendWs", msg: { type: "client:ping" } }]],
    UserClickedClosePill:    (s)      => [toIdle(s), [/* close window + complete queue */]],
    // ... every other cell explicit per canon Invariant 7
  },
  // ... other states
};
```

Read out loud: "Auditing — when Brain requested a tool call → stay, forward
the tool. When Brain signalled audit done → become Done. When Brain's
connection errored → mark degraded. When timer fired heartbeat → send a
ping. When user clicked the close pill → become idle, close the window."

That's the poem the convention exists to produce.

## What this doc deliberately doesn't cover

- Cmd algebra, Sub lifecycle, `Transitions` mapped-type semantics — see
  [`tea-invariants.md`](./tea-invariants.md) and the substrate API in
  [`packages/tea/README.md`](../../README.md).
- GraphQL schema design — see the Domain-Driven Schema guidance in the originating monorepo.
  Both docs are about naming things that cross a boundary; they apply to
  different boundaries.

## Sources

The conventions in this doc are not invented. They are the Elm community's
settled answer to "how to name a Msg," ported to TypeScript:

- **Noah Z. Gordon — "Message Naming Conventions"** (talk). The 3-question
  framework (What/Who/Where) originates here. Summarized by Duncan
  Malashock at <https://dmalashock.com/posts/summary-message-naming-conventions/>.
- **Chadtech — "Naming Elm Msgs"** (gist). The "split per cause, not per
  effect" principle and the endorsement of no-op Msgs.
  <https://gist.github.com/Chadtech/89d9e085c3c5bf79602cceb53fbd6e31>.
- **NoRedInk Elm Style Guide.** The "long descriptive names always" rule
  and the exhaustive-case rule.
  <https://github.com/NoRedInk/elm-style-guide>.
- **Elm official style guide.** <https://elm-lang.org/docs/style-guide>.
- **The Elm Architecture (guide).** <https://guide.elm-lang.org/architecture/>.

Older lineage the binary `Cmd` distinction descends from:

- Erlang's `gen_server` (1986) — `call` (request-response) / `cast`
  (fire-and-forget).
- Akka actors — `ask` / `tell`.
- Redux community pattern — `REQUEST` → `SUCCESS` / `FAILURE` triplet
  encodes the `into` callback explicitly as three separate actions.
