# Pattern 14 — Ports and Interop (The JS Boundary)

## The fundamental rule

> **TEA owns all application state. JS owns all browser API access.**

Elm never touches localStorage, WebSocket, or Intl directly. JS never makes
decisions about what to display or how the model should change. The boundary
is always **data in, data out**.

Source: https://github.com/elm-community/js-integration-examples

## The five interop mechanisms

| Mechanism | Direction | Timing | Use when |
|-----------|-----------|--------|----------|
| **Flags** | JS → Elm | Once, at startup (synchronous) | Loading cached/config data before app starts |
| **Cmd port** | Elm → JS | On demand, from update | Elm needs to trigger a JS side effect |
| **Sub port** | JS → Elm | Continuous, from subscriptions | JS events arrive at unpredictable times |
| **Custom Element** | Elm → JS (via attributes) | On render | JS does synchronous, stateless rendering |
| **Custom Element + Event** | JS → Elm (via DOM events) | On interaction | Custom element sends data back |

## Pattern 1: Persistence (localStorage)

Source: `elm-community/js-integration-examples/localStorage/`

**Load path:** Flags (synchronous, one-shot, before init)
**Save path:** Cmd port (every update, via wrapper function)

```elm
-- PORT: outgoing only
port setStorage : E.Value -> Cmd msg

-- Load via flags — data is available before init runs
init : E.Value -> ( Model, Cmd Msg )
init flags =
  ( case D.decodeValue decoder flags of
      Ok model -> model
      Err _ -> { name = "", email = "" }
  , Cmd.none
  )

-- Save via wrapper — every update automatically persists
updateWithStorage : Msg -> Model -> ( Model, Cmd Msg )
updateWithStorage msg oldModel =
  let
    ( newModel, cmds ) = update msg oldModel
  in
  ( newModel
  , Cmd.batch [ setStorage (encode newModel), cmds ]
  )
```

JS side:
```javascript
// Load: read from storage, pass as flags
var storedData = localStorage.getItem('myapp-model');
var flags = storedData ? JSON.parse(storedData) : null;
var app = Elm.Main.init({ node: document.getElementById('myapp'), flags: flags });

// Save: subscribe to the port
app.ports.setStorage.subscribe(function(state) {
  localStorage.setItem('myapp-model', JSON.stringify(state));
});
```

**Key insight:** The `updateWithStorage` wrapper is a cross-cutting concern.
`update` stays pure and testable (returns `Cmd.none` for its own logic).
Persistence is handled at the boundary — every state change is automatically
persisted with no forgotten save calls.

**Why Flags for load (not Sub port)?** Loading is one-shot at startup. Flags
are synchronous — data is available before `init` runs. A Sub port would
require an async round-trip and an intermediate "loading" state.

**Why Cmd port for save (not Sub)?** Saving is imperative — Elm decides when
to push data out. There's no JS-initiated trigger.

## Pattern 2: Streaming (WebSocket)

Source: `elm-community/js-integration-examples/websockets/`

**Send:** Cmd port (Elm → JS, user-initiated)
**Receive:** Sub port (JS → Elm, server-initiated)

```elm
-- TWO PORTS: symmetric pair
port sendMessage : String -> Cmd msg
port messageReceiver : (String -> msg) -> Sub msg

type Msg
  = DraftChanged String
  | Send
  | Recv String

update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
  case msg of
    Send ->
      ( { model | draft = "" }, sendMessage model.draft )
    Recv message ->
      ( { model | messages = model.messages ++ [message] }, Cmd.none )

subscriptions : Model -> Sub Msg
subscriptions _ =
  messageReceiver Recv
```

JS side:
```javascript
var socket = new WebSocket('wss://example.com/echo');

// Elm → JS: subscribe to outgoing port
app.ports.sendMessage.subscribe(function(message) {
  socket.send(message);
});

// JS → Elm: push into incoming port
socket.addEventListener("message", function(event) {
  app.ports.messageReceiver.send(event.data);
});
```

**The asymmetry is fundamental:**
- **Cmd** = Elm decides when, JS executes the effect
- **Sub** = JS decides when, Elm receives the event

This maps to the WebSocket model: send is volitional, receive is reactive.

**Boundary:** Elm owns the data (draft + message list). JS owns the transport
(WebSocket lifecycle, reconnection). Elm never sees the WebSocket object.

## Pattern 3: Custom Elements (No Ports)

Source: `elm-community/js-integration-examples/internationalization/`

When JS work is synchronous and stateless, use a Custom Element instead of ports:

```elm
-- NOT a port module — no ports needed
module Main exposing (..)

viewDate : String -> Int -> Int -> Html msg
viewDate lang year month =
  node "intl-date"
    [ attribute "lang" lang
    , attribute "year" (String.fromInt year)
    , attribute "month" (String.fromInt month)
    ]
    []
```

JS side:
```javascript
customElements.define('intl-date',
  class extends HTMLElement {
    connectedCallback() { this.setTextContent(); }
    attributeChangedCallback() { this.setTextContent(); }
    static get observedAttributes() { return ['lang','year','month']; }
    setTextContent() {
      const lang = this.getAttribute('lang');
      const year = this.getAttribute('year');
      const month = this.getAttribute('month');
      this.textContent = localizeDate(lang, year, month);
    }
  }
);
```

**Why Custom Element instead of ports?** The Intl API is synchronous and
stateless. A port would add:
- A Msg for "I got the formatted date back"
- A Maybe String in the Model for "waiting for JS to respond"
- An async gap between request and response

Custom elements eliminate all of this because the rendering happens in the
DOM, not in the Elm model.

**Data back via events:** Custom elements dispatch standard DOM events that
Elm listens to with `Html.Events.on` and a JSON decoder.

## In TypeScript — the port equivalents

| Elm mechanism | TS equivalent |
|---------------|---------------|
| Flags | Constructor argument to runtime / `init(loaded)` |
| Cmd port | Interpret handler (Cmd → real-world I/O → Msg back) |
| Sub port | Subscribe handler (external event → dispatch Msg) |
| Custom Element | Same (Web Components work in any framework) |

The `interpret` record IS the Cmd port layer. The `subscribe` record IS the
Sub port layer. The shapes are isomorphic:

```typescript
// Elm: port setStorage : E.Value -> Cmd msg
// TS:  interpret handler that calls localStorage
interpret: {
  save_to_storage: async (cmd) => {
    localStorage.setItem(cmd.key, JSON.stringify(cmd.value))
    // fire-and-forget — no Msg returned
  },
}

// Elm: port messageReceiver : (String -> msg) -> Sub msg
// TS:  subscribe handler that listens to WebSocket
subscribe: {
  listen_websocket: (sub, ctx, dispatch) => {
    const ws = new WebSocket(sub.url)
    ws.onmessage = (e) => dispatch({ type: "Recv", data: e.data })
    return () => ws.close()
  },
}
```

## Decision table — which mechanism?

| Your data... | Direction | Timing | Use |
|-------------|-----------|--------|-----|
| Config/cached state at startup | JS → App | Once, synchronous | **Flags** (init argument) |
| User triggers JS side effect | App → JS | On demand | **Cmd** (interpret handler) |
| External events arrive unpredictably | JS → App | Continuous | **Sub** (subscribe handler) |
| JS does synchronous, stateless rendering | App → JS | On render | **Custom Element** (attributes) |
| JS widget sends data back | JS → App | On interaction | **Custom Element + DOM event** |
