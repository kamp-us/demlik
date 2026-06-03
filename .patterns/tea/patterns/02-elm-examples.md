# Pattern 02 — Canonical Elm Examples

These examples come directly from the official Elm guide (https://guide.elm-lang.org)
and the elm/browser source (https://github.com/elm/browser). They are the ground truth
for what TEA looks like. Every other implementation is measured against these.

## The two tiers

Elm has two entry points. `sandbox` is sugar — it wraps your code in
`(Model, Cmd.none)` internally. **There is only one architecture: element.**

```elm
-- From elm/browser/src/Browser.elm (actual source)
sandbox impl =
  Elm.Kernel.Browser.element
    { init = \() -> ( impl.init, Cmd.none )
    , view = impl.view
    , update = \msg model -> ( impl.update msg model, Cmd.none )
    , subscriptions = \_ -> Sub.none
    }
```

| Tier | Entry point | init returns | update returns | subscriptions |
|------|------------|-------------|----------------|---------------|
| Pure | `Browser.sandbox` | `Model` | `Model` | No |
| Effectful | `Browser.element` | `(Model, Cmd Msg)` | `(Model, Cmd Msg)` | `Model -> Sub Msg` |
| Document | `Browser.document` | `(Model, Cmd Msg)` | `(Model, Cmd Msg)` | `Model -> Sub Msg` |
| Application | `Browser.application` | `(Model, Cmd Msg)` | `(Model, Cmd Msg)` | `Model -> Sub Msg` |

### The element signature (from elm/browser source)

```elm
element :
    { init : flags -> ( model, Cmd msg )
    , view : model -> Html msg
    , update : msg -> model -> ( model, Cmd msg )
    , subscriptions : model -> Sub msg
    }
    -> Program flags model msg
```

---

## Example 1: Counter (sandbox — pure Model/Update/View)

Source: https://guide.elm-lang.org/architecture/buttons.html

```elm
import Browser
import Html exposing (Html, button, div, text)
import Html.Events exposing (onClick)

-- MAIN
main =
  Browser.sandbox { init = init, update = update, view = view }

-- MODEL
type alias Model = Int

init : Model
init = 0

-- UPDATE
type Msg = Increment | Decrement

update : Msg -> Model -> Model
update msg model =
  case msg of
    Increment -> model + 1
    Decrement -> model - 1

-- VIEW
view : Model -> Html Msg
view model =
  div []
    [ button [ onClick Decrement ] [ text "-" ]
    , div [] [ text (String.fromInt model) ]
    , button [ onClick Increment ] [ text "+" ]
    ]
```

**What this teaches:**
- Model is just data (an Int)
- Msg is a closed union (`Increment | Decrement`)
- Update is exhaustive pattern match on Msg
- View produces Html that tags user actions as Msg values
- The loop: user input → Msg → update → new Model → view → screen → repeat

---

## Example 2: Text Field (sandbox — Msg with payload)

Source: https://guide.elm-lang.org/architecture/text_fields.html

```elm
-- MODEL
type alias Model = { content : String }

init : Model
init = { content = "" }

-- UPDATE
type Msg = Change String

update : Msg -> Model -> Model
update msg model =
  case msg of
    Change newContent ->
      { model | content = newContent }

-- VIEW
view : Model -> Html Msg
view model =
  div []
    [ input [ placeholder "Text to reverse", value model.content, onInput Change ] []
    , div [] [ text (String.reverse model.content) ]
    ]
```

**What this teaches:**
- Msg variants carry payloads: `Change String`
- `onInput Change` — the view wires DOM events to Msg constructors
- Typing "bard" produces 4 messages: `Change "b"`, `Change "ba"`, `Change "bar"`, `Change "bard"`
- Model is a record even for one field — makes extension easy

---

## Example 3: Form (sandbox — multiple Msg variants, validation)

Source: https://guide.elm-lang.org/architecture/forms.html

```elm
-- MODEL
type alias Model =
  { name : String
  , password : String
  , passwordAgain : String
  }

-- UPDATE
type Msg
  = Name String
  | Password String
  | PasswordAgain String

update : Msg -> Model -> Model
update msg model =
  case msg of
    Name name ->
      { model | name = name }
    Password password ->
      { model | password = password }
    PasswordAgain password ->
      { model | passwordAgain = password }
```

**What this teaches:**
- Each field gets its own Msg variant — "when someone types in field X, generate message X"
- Validation is a plain function of Model, not a side effect
- View helpers (`viewInput`) are just functions — "Since we are using normal Elm functions,
  we have the full power of Elm to help us build our views!"
- Build the model gradually: start minimal, add fields as view/update reveal needs

---

## Example 4: HTTP (element — Commands)

Source: https://guide.elm-lang.org/effects/http.html

```elm
-- MODEL
type Model
  = Failure
  | Loading
  | Success String

init : () -> (Model, Cmd Msg)
init _ =
  ( Loading
  , Http.get
      { url = "https://elm-lang.org/assets/public-opinion.txt"
      , expect = Http.expectString GotText
      }
  )

-- UPDATE
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

-- SUBSCRIPTIONS
subscriptions : Model -> Sub Msg
subscriptions model =
  Sub.none
```

**What this teaches:**
- `init` returns `(Model, Cmd Msg)` — the initial state AND the first command
- Model as a custom type (not alias): `Failure | Loading | Success String`
  makes impossible states impossible
- `Http.get` is a description of what to fetch, not the fetch itself
- Result type in Msg: `GotText (Result Http.Error String)`
- `Cmd.none` when there's nothing to do
- The Elm guide says: "Like always, we have to produce the initial Model, but now
  we are also producing some **command** of what we want to do immediately."

---

## Example 5: Random (element — Commands from update)

Source: https://guide.elm-lang.org/effects/random.html

```elm
-- UPDATE
type Msg = Roll | NewFace Int

update : Msg -> Model -> (Model, Cmd Msg)
update msg model =
  case msg of
    Roll ->
      ( model
      , Random.generate NewFace (Random.int 1 6)
      )
    NewFace newFace ->
      ( Model newFace
      , Cmd.none
      )
```

**What this teaches:**
- Commands can be issued from `update`, not just `init`
- `Roll` doesn't change the model — it issues a command
- `Random.generate` is a description: "we are not actually generating the values yet.
  We are just describing _how_ to generate them."
- The result comes back as a new Msg (`NewFace Int`)
- Generators compose: `Random.map3 Spin symbol symbol symbol`

---

## Example 6: Clock (element — Subscriptions)

Source: https://guide.elm-lang.org/effects/time.html

```elm
-- MODEL
type alias Model =
  { zone : Time.Zone
  , time : Time.Posix
  }

init : () -> (Model, Cmd Msg)
init _ =
  ( Model Time.utc (Time.millisToPosix 0)
  , Task.perform AdjustTimeZone Time.here
  )

-- UPDATE
type Msg
  = Tick Time.Posix
  | AdjustTimeZone Time.Zone

update : Msg -> Model -> (Model, Cmd Msg)
update msg model =
  case msg of
    Tick newTime ->
      ( { model | time = newTime }, Cmd.none )
    AdjustTimeZone newZone ->
      ( { model | zone = newZone }, Cmd.none )

-- SUBSCRIPTIONS
subscriptions : Model -> Sub Msg
subscriptions model =
  Time.every 1000 Tick
```

**What this teaches:**
- Subscriptions are for ongoing interests: "let me know if anything interesting
  happens over there!"
- `subscriptions` is a function of Model — subs can change based on state
- `Time.every 1000 Tick` — every second, produce a `Tick` message
- Commands are one-shot ("do this now"); Subscriptions are continuous ("keep telling me")
- The Elm guide says: "A subscription is a way of telling Elm, 'Hey, let me know if
  anything interesting happens over there!' The cool thing here is that this means
  *Elm* manages all the details of subscriptions instead of *you*."

---

## The TEA loop — from the Elm guide

> "So whenever we get a message, we run it through `update` to get a new model.
> We then call `view` to figure out how to show the new model on screen.
> Then repeat! User input generates a message, `update` the model, `view` it
> on screen. Etc."

The progression from sandbox to element:

1. **sandbox**: Model → View → Update → repeat (no effects)
2. **element**: Model → View → Update → Cmd/Sub → runtime → Msg → repeat

The runtime is the invisible participant that:
- Renders Html efficiently (minimal DOM modifications)
- Turns user actions into Msg values
- Executes Cmds and delivers results as Msgs
- Manages Sub lifecycles (start/stop based on state)

---

## Elm source — Cmd and Sub definitions

From `elm/core/src/Platform/Cmd.elm`:

> **Note:** Elm has **managed effects**, meaning that things like HTTP requests
> or writing to disk are all treated as *data* in Elm. When this data is given
> to the Elm runtime system, it can do some "query optimization" before actually
> performing the effect. Perhaps unexpectedly, this managed effects idea is the
> heart of why Elm is so nice for testing, reuse, reproducibility, etc.

```elm
-- A command is a way of telling Elm, "Hey, I want you to do this thing!"
type Cmd msg = Cmd

none : Cmd msg
none = batch []

batch : List (Cmd msg) -> Cmd msg

map : (a -> msg) -> Cmd a -> Cmd msg
```

From `elm/core/src/Platform/Sub.elm`:

> A subscription is a way of telling Elm, "Hey, let me know if anything
> interesting happens over there!" So if you want to listen for messages on
> a web socket, you would tell Elm to create a subscription. The cool thing
> here is that this means *Elm* manages all the details of subscriptions
> instead of *you*. So if a web socket goes down, *you* do not need to manually
> reconnect with an exponential backoff strategy, *Elm* does this all for you
> behind the scenes!

```elm
type Sub msg = Sub

none : Sub msg
none = batch []

batch : List (Sub msg) -> Sub msg

map : (a -> msg) -> Sub a -> Sub msg
```

---

## raj — the 34-line existence proof

raj (https://github.com/andrejewski/raj) proves TEA doesn't need Elm.
This is the entire runtime:

```javascript
exports.runtime = function (program) {
  var update = program.update
  var view = program.view
  var done = program.done
  var state
  var isRunning = true

  function dispatch (message) {
    if (isRunning) {
      change(update(message, state))
    }
  }

  function change (change) {
    state = change[0]
    var effect = change[1]
    if (effect) {
      effect(dispatch)
    }
    view(state, dispatch)
  }

  change(program.init)

  return function end () {
    if (isRunning) {
      isRunning = false
      if (done) {
        done(state)
      }
    }
  }
}
```

The architecture in 34 lines:
- `program.init` returns `[state, effect]` — the pair
- `update(message, state)` returns `[state, effect]` — the pair again
- `effect(dispatch)` is the entire interpreter — one line
- `view(state, dispatch)` renders after every transition
- `dispatch(message)` feeds a Msg back into the loop

Strip `effect(dispatch)` and you have a reducer with a vestigial second tuple slot.
This is the minimum viable TEA.
