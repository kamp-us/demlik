# Pattern 17 — Production TEA at Scale (elm-spa-example)

Canonical patterns from Richard Feldman's elm-spa-example — the reference
app for "how to build a real app in TEA."

Source: https://github.com/rtfeldman/elm-spa-example

## Page routing — the Model is a union of page states

```elm
type Model
    = Redirect Session
    | NotFound Session
    | Home Home.Model
    | Settings Settings.Model
    | Login Login.Model
    | Profile Username Profile.Model
    | Article Article.Model
    | Editor (Maybe Slug) Editor.Model
```

Each variant wraps a page's sub-model. `Redirect` and `NotFound` carry only
`Session`. The top-level Model IS the router.

## The Msg — one wrapper per page + navigation

```elm
type Msg
    = ChangedUrl Url
    | ClickedLink Browser.UrlRequest
    | GotHomeMsg Home.Msg
    | GotSettingsMsg Settings.Msg
    | GotLoginMsg Login.Msg
    | GotArticleMsg Article.Msg
    | GotSession Session
```

Two navigation events, one `GotXxxMsg` wrapper per page, one cross-cutting
`GotSession` for auth changes.

## updateWith — the universal sub-TEA adapter

```elm
updateWith : (subModel -> Model) -> (subMsg -> Msg) -> Model
    -> ( subModel, Cmd subMsg ) -> ( Model, Cmd Msg )
updateWith toModel toMsg model ( subModel, subCmd ) =
    ( toModel subModel
    , Cmd.map toMsg subCmd
    )
```

Takes a model constructor, a Msg constructor, and a child's `(model, cmd)` pair.
Maps both into the parent's types. Used everywhere:

```elm
-- In changeRouteTo:
Just Route.Home ->
    Home.init session |> updateWith Home GotHomeMsg model

-- In update:
( GotHomeMsg subMsg, Home home ) ->
    Home.update subMsg home |> updateWith Home GotHomeMsg model
```

## Tuple matching — preventing stale messages

```elm
update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case ( msg, model ) of
        ( GotHomeMsg subMsg, Home home ) ->
            Home.update subMsg home |> updateWith Home GotHomeMsg model

        ( GotLoginMsg subMsg, Login login ) ->
            Login.update subMsg login |> updateWith Login GotLoginMsg model

        ( _, _ ) ->
            ( model, Cmd.none )  -- discard messages for wrong page
```

`case (msg, model) of` ensures a `GotHomeMsg` only processes when the model
IS `Home`. Delayed HTTP responses after navigation are silently discarded by
the `(_, _)` catch-all.

## Session — shared state without global mutable state

```elm
type Session
    = LoggedIn Nav.Key Viewer
    | Guest Nav.Key
```

Discriminated union, not a record with `Maybe Viewer`. Guest can never
accidentally have a Viewer. Every page stores session in its model and
exposes `toSession`:

```elm
-- Every page module:
toSession : Model -> Session
toSession model = model.session
```

The parent extracts session via `toSession model` before routing.

**Cross-tab auth sync via ports:**
```elm
port storeCache : Maybe Value -> Cmd msg    -- save credentials
port onStoreChange : (Value -> msg) -> Sub msg  -- listen for changes

-- Login stores credentials:
storeCredWith cred avatar  -- triggers port, JS writes to localStorage

-- Every page subscribes:
subscriptions model =
    Session.changes GotSession (Session.navKey model.session)
```

Login doesn't navigate directly. It stores credentials → port fires → JS
writes localStorage → storage event triggers `onStoreChange` → `GotSession` →
page navigates. Indirect but correct — works across tabs.

## Loading states — the Status type

```elm
type Status a
    = Loading
    | LoadingSlowly
    | Loaded a
    | Failed
```

**Four states, not two.** The critical innovation is `LoadingSlowly`:

```elm
init session =
    ( { tags = Loading, feed = Loading }
    , Cmd.batch
        [ fetchFeed ...
        , Tag.list ...
        , Task.perform (\_ -> PassedSlowLoadThreshold) Loading.slowThreshold
        ]
    )

-- 500ms later, if still loading:
PassedSlowLoadThreshold ->
    let
        feed = case model.feed of
            Loading -> LoadingSlowly
            other -> other
    in
    ( { model | feed = feed }, Cmd.none )
```

On init: fire data requests AND a 500ms delayed Msg. If data arrives before
the threshold → `Loading` → `Loaded` (no spinner). If threshold fires while
still `Loading` → `LoadingSlowly` (show spinner). Prevents spinner flash.

## Form handling

### Form as a separate type

```elm
type alias Model =
    { session : Session
    , problems : List Problem
    , form : Form
    }

type alias Form = { email : String, password : String }
```

### updateForm helper

```elm
updateForm : (Form -> Form) -> Model -> ( Model, Cmd Msg )
updateForm transform model =
    ( { model | form = transform model.form }, Cmd.none )

-- Usage:
EnteredEmail email -> updateForm (\form -> { form | email = email }) model
```

### Validation via TrimmedForm newtype

```elm
type TrimmedForm = Trimmed Form

validate : Form -> Result (List Problem) TrimmedForm
validate form =
    let trimmed = trimFields form in
    case List.concatMap (validateField trimmed) fieldsToValidate of
        [] -> Ok trimmed
        problems -> Err problems
```

`TrimmedForm` is a newtype — you can only get one via `trimFields`. Validation
always operates on trimmed data. Problems are tagged by field:

```elm
type Problem
    = InvalidEntry ValidatedField String
    | ServerError String

type ValidatedField = Email | Password
```

### Submission flow

```
Submit → validate → Ok: clear problems, fire HTTP Cmd
                  → Err: set problems, no Cmd
HTTP response → Ok: store credentials (port)
              → Err: append server errors to problems
```

## API layer — opaque types enforce auth

```elm
-- Opaque: can't construct outside Api module
type Cred = Cred Username String

-- Auth required at the type level:
get : Endpoint -> Maybe Cred -> Decoder a -> Http.Request a  -- works without auth
delete : Endpoint -> Cred -> Body -> Decoder a -> Http.Request a  -- REQUIRES auth
```

You literally cannot call `delete` without credentials. The type system enforces it.

```elm
-- Opaque: can't construct arbitrary URLs
type Endpoint = Endpoint String

login : Endpoint
login = url [ "users", "login" ] []
```

Every valid API endpoint is a named function. No string URLs in business logic.

## The page module contract

Every page exposes exactly:

```elm
module Page.Xxx exposing (Model, Msg, init, subscriptions, toSession, update, view)
```

- `Model` and `Msg` are opaque to the parent
- `init : Session -> [params] -> ( Model, Cmd Msg )`
- `toSession : Model -> Session`
- The parent never reaches into child model fields

## Navigation

```elm
-- Routes carry typed data, not strings
type Route
    = Home | Login | Article Slug | Profile Username | ...

-- Unrecognized URLs → Nothing → NotFound page
fromUrl : Url -> Maybe Route

-- Post-action navigation uses replaceUrl (not pushUrl)
-- so back-button doesn't return to invalid states
Route.replaceUrl (Session.navKey session) Route.Home
```

## Summary table

| Pattern | Mechanism |
|---------|-----------|
| Page as sub-TEA | Uniform interface: `Model, Msg, init, update, view, subscriptions, toSession` |
| updateWith | Universal adapter: lifts any sub-TEA into parent |
| Tuple matching | `case (msg, model)` prevents stale messages |
| Catch-all discard | `(_, _) -> (model, Cmd.none)` for wrong-page msgs |
| Session threading | Passed through init, kept in sync via port subscription |
| Status type | `Loading \| LoadingSlowly \| Loaded a \| Failed` with 500ms threshold |
| Opaque Cred/Endpoint | Auth and URLs enforced at the type level |
| TrimmedForm newtype | Validation always operates on trimmed data |
| updateForm helper | DRYs all field-change handlers |
| replaceUrl after actions | Back button doesn't return to invalid states |
