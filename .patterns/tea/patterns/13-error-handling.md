# Pattern 13 — Error Handling in TEA

## The principle

Errors are Msgs. They flow through the same `update` function as every other
event. There is no try-catch in the reducer, no error boundary around the
loop, no special error channel. An HTTP failure and a button click are both
Msgs — the reducer decides what the next state is.

## From Elm — the Result type

Elm's HTTP module wraps responses in `Result`:

```elm
type Msg
  = GotText (Result Http.Error String)

update : Msg -> Model -> (Model, Cmd Msg)
update msg model =
  case msg of
    GotText result ->
      case result of
        Ok fullText ->
          (Success fullText, Cmd.none)
        Err _ ->
          (Failure, Cmd.none)
```

Source: https://guide.elm-lang.org/effects/http.html

The Msg carries the Result. The reducer pattern-matches on Ok/Err. Both paths
produce `(Model, Cmd Msg)`. No exceptions, no try-catch.

## Http.Error — Elm's error taxonomy

From `elm/http/src/Http.elm`:

```elm
type Error
  = BadUrl String
  | Timeout
  | NetworkError
  | BadStatus Int
  | BadBody String
```

Every possible failure has a name. The reducer can handle each case
differently:

```elm
GotText (Err error) ->
  case error of
    Http.Timeout ->
      (model, retryCmd)        -- retry on timeout
    Http.NetworkError ->
      (Offline, Cmd.none)      -- show offline state
    Http.BadStatus 404 ->
      (NotFound, Cmd.none)     -- specific handling
    _ ->
      (Failure, Cmd.none)      -- generic fallback
```

## In TypeScript

### The Result type in Msg

```typescript
type Msg =
  | { type: "GotText"; result: { ok: true; value: string } | { ok: false; error: FetchError } }
  | { type: "GotQuote"; result: { ok: true; value: Quote } | { ok: false; error: FetchError } }

type FetchError =
  | { type: "Timeout" }
  | { type: "NetworkError" }
  | { type: "BadStatus"; status: number }
  | { type: "BadBody"; message: string }
```

The reducer handles both branches:

```typescript
case "GotText":
  if (msg.result.ok) {
    return [{ type: "Success", text: msg.result.value }, []]
  } else {
    return [{ type: "Failure", error: msg.result.error }, []]
  }
```

### The interpreter produces Result Msgs

The interpreter wraps the real-world call and routes success/failure
to the appropriate Msg:

```typescript
const interpret = {
  fetch_book: async (cmd) => {
    try {
      const res = await fetch(cmd.url)
      if (!res.ok) {
        return { type: "GotText", result: { ok: false, error: { type: "BadStatus", status: res.status } } }
      }
      const text = await res.text()
      return { type: "GotText", result: { ok: true, value: text } }
    } catch (e) {
      return { type: "GotText", result: { ok: false, error: { type: "NetworkError" } } }
    }
  },
}
```

The try-catch lives in the interpreter — never in the reducer. The interpreter
translates real-world exceptions into typed Result Msgs.

### Railway-oriented interpret

A helper can standardize this pattern:

```typescript
function tryInterpret(work, onOk, onErr) {
  return async (cmd) => {
    try {
      const value = await work(cmd)
      return onOk(value, cmd)
    } catch (error) {
      return onErr(error, cmd)
    }
  }
}

const interpret = {
  fetch_book: tryInterpret(
    (cmd) => fetch(cmd.url).then(r => r.text()),
    (text) => ({ type: "GotText", result: { ok: true, value: text } }),
    (err) => ({ type: "GotText", result: { ok: false, error: { type: "NetworkError" } } }),
  ),
}
```

This is the Railway pattern — success and failure are two tracks, both
producing a Msg. The interpreter never throws to the runtime.

## Msg arm vs log — when to handle errors in the reducer vs log and drop

From the handoff research on the three tripping cases:

| Error shape | Handle in reducer (Msg arm) | Log and drop |
|-------------|---------------------------|--------------|
| **Recoverable** — user can retry, state can change | Yes — the error IS the next state | No |
| **Unrecoverable** — crash, bug, corrupted data | No — nothing useful to show the user | Yes — telemetry/stderr |
| **Boundary** — external system returned garbage | Parse and handle if recoverable | Log if the parse itself fails |

The decision: "Can the reducer do something meaningful with this error?"
If yes → Msg arm. If no → log at the boundary, don't pollute the Msg union.

## The canonical pattern — localStorage

From `elm-community/js-integration-examples/localStorage/Main.elm`:

```elm
-- Persistence is a Cmd-to-port, not a try-catch
port setStorage : E.Value -> Cmd msg

updateWithStorage : Msg -> Model -> ( Model, Cmd Msg )
updateWithStorage msg oldModel =
  let
    ( newModel, cmds ) = update msg oldModel
  in
  ( newModel
  , Cmd.batch [ setStorage (encode newModel), cmds ]
  )
```

Storage writes are Cmds. If `setStorage` fails on the JS side, the error
comes back through a port as a Msg — not as an exception in the reducer.

## The canonical pattern — WebSocket

From `elm-community/js-integration-examples/websockets/Main.elm`:

```elm
-- Receiving is a Sub (ongoing)
port messageReceiver : (String -> msg) -> Sub msg

subscriptions : Model -> Sub Msg
subscriptions _ =
  messageReceiver Recv

-- Sending is a Cmd (one-shot)
port sendMessage : String -> Cmd msg

update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
  case msg of
    Send ->
      ( { model | draft = "" }
      , sendMessage model.draft
      )
    Recv message ->
      ( { model | messages = model.messages ++ [message] }
      , Cmd.none
      )
```

Sending = Cmd (one-shot command). Receiving = Sub (ongoing subscription).
WebSocket lifecycle (connect, reconnect, backoff) lives in the JS
subscription handler, not in the Elm reducer.

## Decision table

| Situation | Pattern |
|-----------|---------|
| HTTP call might fail | Result type in Msg, pattern match on Ok/Err in reducer |
| Need to retry on timeout | Return a retry Cmd from the error branch in update |
| External system returns garbage | Parse in interpreter, send BadBody error Msg |
| Storage write might fail | Cmd-to-port, error flows back as Msg |
| WebSocket might disconnect | Sub handler manages reconnect, reducer sees Recv Msgs |
| Bug in the reducer itself | Should never happen — this is a crash, not an error |
| Interpreter throws unexpectedly | tryInterpret wrapper catches and routes to error Msg |

Source: https://guide.elm-lang.org/effects/http.html
Source: https://github.com/elm/http/blob/master/src/Http.elm
Source: https://github.com/elm-community/js-integration-examples
