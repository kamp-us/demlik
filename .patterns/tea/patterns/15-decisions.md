# Pattern 15 — Decision Tables (The Recipe Layer)

Pre-decided choices for recurring TEA questions. Each table resolves one
ambiguity so agents don't reinvent the answer.

## Decision 1: Cmd vs Sub

From the Elm guide:
> **Commands** — you tell the runtime to do specific work **right now**
> **Subscriptions** — you declare an ongoing interest in something

| Your effect... | Use | Why |
|---------------|-----|-----|
| Is triggered by a user action or state transition | **Cmd** | Elm decides when. One-shot. |
| Produces events at unpredictable times from outside | **Sub** | JS/external decides when. Ongoing. |
| Fires once and returns a result | **Cmd** | HTTP, random, file read |
| Needs lifecycle management (start/stop) | **Sub** | Timer, WebSocket, event listener |
| Is fire-and-forget (no result needed) | **Cmd** | Analytics, logging, storage write |

Source: https://guide.elm-lang.org/effects/

The Elm guide's time example makes this concrete:
- "Get the current time zone" → **Cmd** (`Task.perform AdjustTimeZone Time.here`)
- "Tell me the time every second" → **Sub** (`Time.every 1000 Tick`)

## Decision 2: Init shape — Cmd.none vs boot effects

| Your app needs at startup... | Do this |
|-----------------------------|---------|
| Nothing — pure initial state | `init = () -> (model, Cmd.none)` |
| One async fetch | `init = () -> (Loading, fetchCmd)` |
| Multiple independent fetches | `init = () -> (Loading, Cmd.batch [fetch1, fetch2])` |
| Data from JS (localStorage, config) | Use **flags**: `init = flags -> (decodeFlags flags, Cmd.none)` |
| State-conditional resume after crash | Don't put resume logic in init. Dispatch a `Boot` Msg from the host after the runtime starts. |

From the Elm guide HTTP example:
```elm
init : () -> (Model, Cmd Msg)
init _ =
  ( Loading
  , Http.get { url = "...", expect = Http.expectString GotText }
  )
```

Init returns the loading state AND the command to fetch. Both in one atomic pair.

## Decision 3: Persistence — when to save

| Your persistence need... | Pattern | Canonical source |
|-------------------------|---------|-----------------|
| Save entire model on every change | `updateWithStorage` wrapper — intercepts every update, batches a save Cmd | localStorage example |
| Save only when specific events happen | Return a save Cmd from those specific update branches | Standard Cmd pattern |
| Load state at startup | Flags (synchronous, before init) | localStorage example |
| Load state from async source | Cmd in init, Loading state until response | HTTP example |

Source: `elm-community/js-integration-examples/localStorage/`

The `updateWithStorage` wrapper pattern:
```elm
updateWithStorage msg oldModel =
  let
    ( newModel, cmds ) = update msg oldModel
  in
  ( newModel, Cmd.batch [ setStorage (encode newModel), cmds ] )
```

`update` stays pure. Persistence is a cross-cutting concern at the boundary.

## Decision 4: Sub gating — always-on vs phase-gated

| Your subscription... | Gate it? | Why |
|---------------------|----------|-----|
| Catches an input stream that must not miss events | **Always-on** (gate only by `!= destroyed`) | Race-freedom: if you gate by phase, events during phase transitions are dropped |
| Costs resources (timer, polling, connection) | **Phase-gated** — only active when needed | Don't burn resources in phases that don't use the data |
| Observes something that's always relevant (resize, online/offline) | **Always-on** | The event could matter in any phase |

From the Elm WebSocket example:
```elm
subscriptions : Model -> Sub Msg
subscriptions _ =
  messageReceiver Recv  -- always-on, no gating
```

From the Elm time example:
```elm
subscriptions : Model -> Sub Msg
subscriptions model =
  Time.every 1000 Tick  -- always-on in this example
```

For a pausable clock, you'd gate:
```elm
subscriptions model =
  if model.paused then Sub.none
  else Time.every 1000 Tick
```

## Decision 5: Msg arm vs log

| Your error... | Handle in reducer (Msg arm) | Log and drop |
|--------------|---------------------------|--------------|
| User can retry or the state should change | **Msg arm** — the error IS the next state | No |
| Unrecoverable (bug, crash, corrupted data) | No — nothing the reducer can do | **Log** — telemetry/stderr |
| Boundary parse failed (garbage from external system) | **Msg arm** if recoverable | **Log** if the parse itself is meaningless |

The test: "Can the reducer do something meaningful with this error?"
If yes → Msg arm. If no → log at the interpreter boundary.

From Elm's HTTP example:
```elm
GotText result ->
  case result of
    Ok fullText -> (Success fullText, Cmd.none)   -- Msg arm: success
    Err _ -> (Failure, Cmd.none)                   -- Msg arm: failure changes state
```

Both Ok and Err are Msg arms because both produce meaningful state transitions.

## Decision 6: When to split into sub-machines

| Symptom | Action |
|---------|--------|
| >50% of transition cells are no-ops | Split by phase — each phase gets its own machine |
| >20 Msg variants | Split by feature — group related Msgs into a child machine |
| Msgs are prefixed by feature name (`LoginSubmit`, `LoginError`) | That prefix IS the child machine |
| Two parts of state are independent (never read each other) | Two machines — compose at the parent level |
| State has distinct lifecycle phases | Use Transitions form (phase-keyed dispatch) |

Source: Richard Feldman — "Scaling Elm Apps" (Elm Europe 2017)
Source: https://github.com/rtfeldman/elm-spa-example

## Decision 7: Cmd ordering within a transition

| Your Cmds in one transition... | Do this |
|-------------------------------|---------|
| Are independent (order doesn't matter) | Return them in a flat array / `Cmd.batch` |
| Must execute sequentially | **Don't** — chain via Msgs instead. Cmd A returns Msg, Msg triggers Cmd B |
| Are the same Cmd with different params | Return them all — the interpreter executes sequentially |

From `elm/core/src/Platform/Cmd.elm`:
```elm
batch : List (Cmd msg) -> Cmd msg
```

Elm's `Cmd.batch` gives **no ordering guarantee**. If you need ordering,
encode it as state transitions: Cmd A completes → Msg → update → Cmd B.

## Decision 8: Model field — store or derive?

| Your data... | Store in Model | Derive in view/helper |
|-------------|---------------|----------------------|
| Changes only via Msgs | **Store** | — |
| Is a function of other Model fields | — | **Derive** |
| Is expensive to compute and rarely changes | **Store** (memoize) | — |
| Is a boolean that mirrors a union check | — | **Derive** (`state.type === "loading"`) |

From the Elm forms example — validation is derived, not stored:
```elm
viewValidation model =
  if model.password == model.passwordAgain then
    div [ style "color" "green" ] [ text "OK" ]
  else
    div [ style "color" "red" ] [ text "Passwords do not match!" ]
```

No `isValid: boolean` in the Model. Derive it.
