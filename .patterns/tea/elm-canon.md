# The Elm Canon — TypeScript Port Reference

The canonical mapping from Elm / The Elm Architecture (TEA) to the `@demlik/tea*`
package suite that lives in this monorepo. Every Elm concept on
[`guide.elm-lang.org`][elm-guide], the [`elm-architecture-tutorial`][eat-repo],
and the historical [`elm-lang.org`][elm-org-repo] posts that produced it has a
column on the right showing how we express it in TypeScript.

This document is the source-of-truth reference while we port and consume TEA.
If a TEA idea is in Elm but missing here, it's a gap — open an issue against
this doc.

[elm-guide]: https://github.com/evancz/guide.elm-lang.org
[eat-repo]: https://github.com/evancz/elm-architecture-tutorial
[elm-org-repo]: https://github.com/elm/elm-lang.org

---

## Why this document exists

The repo runs The Elm Architecture as substrate — not as inspiration. The
`@demlik/tea*` package family expresses TEA in TypeScript:

| Package | Role | Analogue in Elm |
|---|---|---|
| `@demlik/tea` | Pure substrate. `Machine`, `Runtime`, `Cmd`, `Sub`, `Port`, `Store`, `run`, `tryInterpret`. | The unwritten "core" of Elm's runtime system. |
| `@demlik/tea/react` | React host. `useMachine`, `useRuntime` on `useSyncExternalStore`. | `Browser.element` / `Browser.document`. |
| `@demlik/tea/extension` | Chrome extension cross-context bridge. `bridgeRuntime`, `bridgeClient`, `bridgeTabClient`, `useBackgroundRuntime`. | Has no Elm analogue — ports + custom transport. |
| `@demlik/tea/do` | Cloudflare Durable Object adapter. `doStore`, `doSubscribe` with alarm + websocket Sub variants. | No analogue — server-side persistent runtime. |
| `@demlik/tea/work-queue` | Substrate-agnostic queue lifecycle over `Store<S>`. | No analogue — domain library on top. |
| `@demlik/tea/mem` | In-memory `Store<S>` (test/volatile). | No analogue — Elm doesn't expose Store. |
| `@demlik/tea/devtools` | Presentational inspector (state + msg log). | The (now archived) `elm-debugger`. |

Everything in Elm's TEA chapter is either already a primitive in `@demlik/tea`,
a host adapter in one of the satellite packages, or a deliberate non-goal
listed at the end of this document.

---

## Section 1 — The Elm Architecture (the one-page version)

> "An infinite number of programmers typing into an infinite number of
> computers will eventually rewrite your program in The Elm Architecture."
> — folklore.

TEA is three things and a loop:

1. **Model** — a single immutable value that represents the entire program
   state.
2. **Update** — a pure function `(Msg, Model) → (Model, Cmd Msg)` that
   produces the next Model and a list of commands to run.
3. **View** — a pure function `Model → Html Msg`. (In our world: `(Model) → JSX`.)

Plus:

- **Cmd** — a request to the runtime to *do* something side-effectful (HTTP,
  random number, dispatch a future Msg).
- **Sub** — a declaration that the runtime should *listen* for something
  (time tick, websocket message, alarm fire). Reconciled every transition.

The pure code never *performs* effects. It produces Cmd / Sub values that
**describe** effects. The runtime performs them and sends results back as
Msgs. That separation is the whole game: every effect is replayable, every
state is reachable, every transition is observable.

```
                    ┌──────────────┐
       Msg ────────▶│    update    │
                    │ (pure)       │
                    └──────┬───────┘
                           │ (Model, Cmd Msg)
                    ┌──────▼───────┐
                    │   runtime    │◀──── Cmd / Sub effects
                    └──────┬───────┘            │
                           │ Model              ▼
                    ┌──────▼───────┐     external world
                    │     view     │      (DOM, HTTP, time, …)
                    │ (pure)       │            │
                    └──────────────┘            │
                                                ▼
                                              Msg ───── back to update
```

In `@demlik/tea` the same loop is expressed as:

```ts
import { defineMachine, run } from "@demlik/tea";

const machine = defineMachine<Model, Msg, Cmd, Sub, Ctx>({
  init: (loaded, ctx) => [initialModel, []],          // (Model, [Cmd])
  update: (state, msg) => [nextModel, [cmd]],         // pure
  subscriptions: (state) => [sub],                    // pure list of Sub
  interpret: { cmdType: async (cmd, ctx) => msg },    // host: turns Cmd → Msg
  subscribe: { subType: (sub, ctx, dispatch) => () => cleanup },
});

const runtime = run(machine, { ctx, store });
```

The shape is the same. The difference is that Elm has a single, opinionated
runtime; we expose `run` so the *host* (React, Durable Object, content
script, service worker) builds its own.

---

## Section 2 — Chapter-by-chapter cross-walk

### 2.1 `Browser.sandbox` — pure UI, no effects

Elm guide: `architecture/buttons.md`, `architecture/text_fields.md`,
`architecture/forms.md`, `architecture/checkboxes.md`, `architecture/radio_buttons.md`.

```elm
main = Browser.sandbox { init = init, update = update, view = view }
```

`sandbox` is the no-effects variant. `update` returns just `Model`, not
`(Model, Cmd Msg)`. There are no subscriptions. The "type to reverse"
example, the increment/decrement counter, the form validator — all
`Browser.sandbox`.

In `@demlik/tea` you build the same thing by returning `[next, []]` from
`update` and omitting `interpret` for any commands:

```ts
const machine = defineMachine<number, "inc" | "dec", never, never, {}>({
  init: () => [0, []],
  update: (n, msg) => [msg === "inc" ? n + 1 : n - 1, []],
  interpret: {} as never,
});

// in a React component
function Counter() {
  const [count, dispatch] = useMachine(machine, { ctx: {} });
  return (
    <>
      <button onClick={() => dispatch("dec")}>-</button>
      <span>{count}</span>
      <button onClick={() => dispatch("inc")}>+</button>
    </>
  );
}
```

The view is JSX, but the shape is byte-for-byte equivalent: events become
Msgs, Msgs are dispatched, the runtime re-renders.

**Reusable views vs reusable components** — `architecture/checkboxes.md`
makes the point that in TEA you should reach for *reusable views* (functions
that take props and return Html, with the parent owning the Msg) before
reaching for *reusable components* (a self-contained Model + Msg + update +
view). We follow the same rule: a `<Checkbox />` taking `checked` and
`onChange` props is preferred over a `useCheckboxMachine()` with its own
state. Components only earn their own Model/Msg when they cross a
persistence or lifetime boundary the parent can't represent.

### 2.2 `Browser.element` — effects enter

Elm guide: `effects/README.md`, `effects/http.md`.

`Browser.element` is `sandbox` plus `Cmd` and `Sub`:

```elm
main = Browser.element
  { init = init                -- () -> (Model, Cmd Msg)
  , update = update            -- Msg -> Model -> (Model, Cmd Msg)
  , subscriptions = subs       -- Model -> Sub Msg
  , view = view
  }
```

The whole-program shape is what `@demlik/tea` calls a `Machine`:

```ts
// packages/tea/src/index.ts
export interface Machine<S, M, C extends Cmd, U extends Sub, Ctx> {
  init: (loaded: S | null, ctx: Ctx) => [S, readonly C[]];
  update: (state: S, msg: M) => [S, readonly C[]];
  subscriptions?: (state: S) => readonly U[];
  interpret: { [K in C["type"]]: (cmd: Extract<C, { type: K }>, ctx: Ctx & PortEmitter) => Promise<M | void> };
  subscribe?: { [K in U["type"]]: (sub: Extract<U, { type: K }>, ctx: Ctx, dispatch: (msg: M) => Promise<void>) => () => void };
}
```

Key difference: Elm's runtime owns `interpret` (the implementation of every
Cmd type) and `subscribe` (the runtime side of every Sub type). We move
those into the Machine itself, keyed by tag, so the host can supply them.
That's how the same `Machine` can run inside React, a Durable Object, a
service worker, or a Node test process without the pure code changing.

### 2.3 The `init` contract

Elm guide: `effects/http.md` "init" section.

```elm
init : () -> (Model, Cmd Msg)
init _ =
  ( Loading
  , Http.get { url = "...", expect = Http.expectString GotText }
  )
```

`init` is allowed to return a Cmd, so a program can start work the instant
it boots. Elm's runtime walks that initial Cmd before the first Sub
reconciliation.

In `@demlik/tea` the contract is the same, with one wrinkle: `init` receives
a `loaded: S | null` first argument so persisted state (if any) flows in
before the first transition.

```ts
init: (loaded, ctx) => {
  if (loaded !== null) return [loaded, []];
  return [{ phase: "loading" }, [{ type: "http_get", url: "..." }]];
}
```

Why the asymmetry? Elm's `init` ignores any persisted state because there
is no built-in persistence — Elm sees a fresh program every page load. We
target Durable Objects and chrome storage, where the runtime can resume
mid-transition. `loaded` is how that resume happens.

The runtime guarantees `init` runs **synchronously** when no store is
configured (so `useSyncExternalStore` consumers don't see an undefined
flicker), and **after `store.load()`** when one is. See
`packages/tea/src/index.ts:stepBootEffects` for the contract.

### 2.4 `Cmd` — one-shot side effects

Elm guide: `effects/http.md`, `effects/random.md`.

```elm
Http.get { url = "...", expect = Http.expectString GotText }
-- has type: Cmd Msg
```

`Cmd Msg` is a description of an effect that, when run, will eventually
fire a Msg. The Msg constructor is part of the value (here `GotText`
inside `expectString`).

Our `Cmd` is a tagged union:

```ts
// packages/tea/src/index.ts
export type Cmd<T extends string = string> = { type: T };

// concrete:
type AppCmd =
  | { type: "http_get"; url: string; into: (result: Result<HttpError, string>) => Msg }
  | { type: "log"; line: string };
```

The `into` callback plays the role of Elm's `expectString GotText` — it
lets the Cmd carry "what Msg do I become when I'm done?" alongside the
input.

A handler in `interpret` runs the actual work:

```ts
interpret: {
  http_get: tryInterpret(
    async (cmd, ctx) => fetch(cmd.url).then(r => r.text()),
    (text, cmd) => cmd.into(Result.ok(text)),
    (err, cmd) => cmd.into(Result.err(toHttpError(err))),
  ),
  log: async (cmd, _ctx) => {
    console.log(cmd.line);
    // returning void means no follow-up Msg
  },
}
```

`tryInterpret` is our Railway-style sugar (see Section 4.6) over
`Result.tryPromise` from `better-result`. It guarantees the handler never
rejects — the success or failure both become a Msg the update function can
case on.

### 2.5 `Sub` — continuous sources of Msgs

Elm guide: `effects/time.md`.

```elm
subscriptions : Model -> Sub Msg
subscriptions model =
  Time.every 1000 Tick
```

A Sub is "tell me when something happens." Elm reconciles the Sub list
every transition: new ids start, removed ids stop, same ids are left alone.
That's the rule that makes `subscriptions : Model -> Sub Msg` work — the
function is *called every transition*, and the difference between the new
returned list and the previously-active set drives the actual `addEventListener` /
`setInterval` / `setTimeout` plumbing.

Ours uses the identical rule. The `Sub.id` field is the diff key:

```ts
// packages/tea/src/index.ts
export type Sub<T extends string = string> = { id: string; type: T };

// subscriptions returns the desired set; runtime diffs against current registry
type AppSub =
  | { id: string; type: "tick"; every: number; into: (now: number) => Msg }
  | { id: string; type: "ws"; socketId: string; msg: (data: string) => Msg };

subscriptions: (state) => state.phase === "running" ? [
  { id: "main-tick", type: "tick", every: 1000, into: (now) => ({ tag: "tick", now }) },
] : []
```

Reconcile logic: `packages/tea/src/index.ts:reconcileSubs`. Same id across
transitions = same subscription, no churn. To *force* a restart, emit a
different id (`main-tick-v2`).

### 2.6 Effects: HTTP

Elm guide: `effects/http.md`.

Elm models loading as a discriminated union, not a `loading: bool`:

```elm
type Model = Failure | Loading | Success String
```

That's the entire `Model` for the book-loader example. We do exactly the
same.
Loading states *are* model variants. Adding a `isLoading: boolean` field
next to optional `result?: String` is the anti-pattern this section exists
to prevent.

The Result type Elm uses for HTTP:

```elm
GotText (Result Http.Error String)
```

We use `better-result`:

```ts
import { Result } from "better-result";

type Msg = { tag: "got_text"; result: Result<HttpError, string> };

update: (state, msg) => {
  if (msg.tag !== "got_text") return [state, []];
  return msg.result.match({
    ok: (text) => [{ phase: "success", text }, []],
    err: (_) => [{ phase: "failure" }, []],
  });
}
```

### 2.7 Effects: JSON decoding

Elm guide: `effects/json.md`.

Elm has decoders — composable parsers from `Json.Decode.Value` to a
domain type. They are the canonical "Parse, Don't Validate" example:

```elm
type alias Quote = { quote : String, source : String, author : String, year : Int }

quoteDecoder : Decoder Quote
quoteDecoder =
  map4 Quote
    (field "quote" string)
    (field "source" string)
    (field "author" string)
    (field "year" int)

Http.expectJson GotQuote quoteDecoder
```

Our equivalent: a zod schema at the boundary. The decoder turns unknown
bytes into a parsed domain type or a parse error — same shape as
`Result.tryPromise`:

```ts
import { z } from "zod";

const Quote = z.object({
  quote: z.string(),
  source: z.string(),
  author: z.string(),
  year: z.number().int(),
});
type Quote = z.infer<typeof Quote>;

interpret: {
  http_get_quote: tryInterpret(
    async (cmd, ctx) => Quote.parse(await fetch(cmd.url).then(r => r.json())),
    (quote, cmd) => cmd.into(Result.ok(quote)),
    (err, cmd) => cmd.into(Result.err(toHttpError(err))),
  ),
}
```

This is the pattern named in `docs/design-patterns.md` as **Parse, Don't
Validate**. Raw `unknown` never propagates past the Cmd handler — by the
time the Msg reaches `update`, the payload is the parsed domain type.

### 2.8 Effects: Random

Elm guide: `effects/random.md`.

```elm
Random.generate NewFace (Random.int 1 6)
-- has type: Cmd Msg
```

Two parts: a `Generator` (pure description of "an int between 1 and 6")
and `Random.generate` which lifts a Generator into a Cmd that fires a Msg
with the produced value.

Ours is one tagged Cmd plus a host-supplied randomness source on `ctx`:

```ts
type AppCmd = { type: "roll_die"; sides: number; into: (n: number) => Msg };

interpret: {
  roll_die: async (cmd, ctx) => cmd.into(ctx.random.intInRange(1, cmd.sides)),
}
```

We don't reproduce Elm's full `Generator` algebra (combining generators
with `map`, `andThen`, etc.) because we rarely need it. When we do, build
a function-of-Random returning the next value, not a new abstraction.

### 2.9 Effects: Time

Elm guide: `effects/time.md`.

Three concepts:

- `Time.Posix` — wall-clock instant. (We use `number` ms since epoch, or
  `Date`.)
- `Time.Zone` — IANA zone. (We use `string` like `"Europe/Istanbul"`.)
- `Time.every interval Tick` — Sub. (Mapped to `{ id, type: "tick", every }`.)
- `Task.perform AdjustTimeZone Time.here` — Cmd that grabs the current
  zone. (Mapped to `{ type: "get_zone", into: ... }`.)

`Task` itself — Elm's "deferred effect that doesn't fire a Msg until you
`perform` it" — does not have a direct analogue. Every effect in our world
is a Cmd; if you want to compose effects, compose Promises inside an
`interpret` handler, or chain Msgs through `update`. The Task/Cmd split
exists in Elm because Elm's strict purity forbids "Promise.then in the
view" — we don't need the workaround.

### 2.10 Webapps: `Browser.document` and `Browser.application`

Elm guide: `webapps/README.md`, `webapps/navigation.md`,
`webapps/url_parsing.md`, `webapps/structure.md`, `webapps/modules.md`.

`Browser.document` lets your program control `<title>` and `<body>`:

```elm
main = Browser.document { init = init, update = update, view = view, subscriptions = subs }
view : Model -> { title : String, body : List (Html Msg) }
```

`Browser.application` adds URL handling:

```elm
main = Browser.application
  { init = init
  , view = view
  , update = update
  , subscriptions = subs
  , onUrlRequest = LinkClicked     -- intercept <a href> clicks
  , onUrlChange = UrlChanged       -- fire on browser nav (back, forward)
  }
```

We do not have a direct `Browser.application` analogue — the apps/web Next
app owns URL state through the Next router and Relay route params, and TEA
machines own *fragments* (a sidepanel page, an audit run, a widget) rather
than the whole app. The `onUrlChange` style is what
`packages/tea-extension/src/bridge.ts:bridgeRuntime` does for cross-context
sync: every transition is broadcast, every surface observes.

#### Structure — "Do Not Plan Ahead"

`webapps/structure.md` says, plainly: don't share Model/Msg across pages.
Don't preemptively build a `Post` module that "could be used everywhere."
Write the page first, then notice if anything truly repeats. For
consumers (audit runs, widget pages, sidepanel views) the rule is
pages-first, abstraction-second. Substrate modules follow the opposite
rule (`docs/design-patterns.md` — "Nullable Is Two Functions" + the
design-first principle); the distinction is consumer vs substrate.

#### Modules — parent/child Msg

`webapps/modules.md` describes the canonical TEA composition pattern:
a child has its own `Model` / `Msg` / `update` / `view`, and the parent
wires it in:

```elm
type Msg = ... | ChildMsg Child.Msg

update msg model =
  case msg of
    ChildMsg childMsg ->
      let (newChildModel, childCmd) = Child.update childMsg model.child
      in ({ model | child = newChildModel }, Cmd.map ChildMsg childCmd)
```

`@demlik/tea` has no `Cmd.map` / `Sub.map`. Parent and child share a single
flat Cmd union; the parent's `interpret` handles every variant. TS
discriminated unions cost nothing at runtime, so flat unions outperform
nested-component composition for most cases.

### 2.11 Interop: Flags

Elm guide: `interop/flags.md`.

Flags = data the host passes in at boot:

```html
<script src="elm.js"></script>
<script>
  var app = Elm.Main.init({ node: document.getElementById('elm'), flags: { user: "Tom", token: "..." } });
</script>
```

```elm
init : Flags -> (Model, Cmd Msg)
init flags = ...
```

Two of our APIs play this role together:

1. **`init(loaded, ctx)`** — `ctx` is the host's injected dependency bag.
   That's where you put `{ user, apiClient, fetch, random }`. It's not
   re-parseable like Elm flags but it serves the same purpose: data from
   *outside* the machine.
2. **`store.load()`** — the persisted state. That's how a Durable Object
   resumes an audit run mid-flight. Elm has no equivalent.

Together they make `init: (loaded, ctx) => [state, cmds]` cover both
"first boot with flags" and "resume from snapshot."

### 2.12 Interop: Ports

Elm guide: `interop/ports.md`.

**Ports in Elm are the canonical inspiration for `@demlik/tea`'s `Port`
primitive — read this section twice.**

Elm declares ports inside a `port module`:

```elm
port module Main exposing (..)

port sendMessage : String -> Cmd msg   -- outgoing: data leaves Elm
port messageReceiver : (String -> msg) -> Sub msg  -- incoming: data enters Elm
```

JavaScript subscribes:

```js
app.ports.sendMessage.subscribe(function(message) { ... });
app.ports.messageReceiver.send("hello from JS");
```

Three properties of Elm ports that we faithfully preserve:

1. **Typed.** The port has a single value type. We use TS generics
   (`Port<T>`).
2. **Selective.** Outgoing ports are NOT folded into Model and they are
   NOT broadcast through `observe`. Subscribers only see what was sent.
3. **Identity by declaration.** Each `port` declaration is a unique
   symbol. We mirror that with `Port` being a branded object — identity
   by reference, not by name. Two `definePort<T>("foo")` calls produce
   *two distinct ports*.

```ts
// packages/tea/src/index.ts
export interface Port<T> {
  readonly __brand: "port";
  readonly name: string;
  readonly __t?: T;  // phantom carrier
}

export function definePort<T>(name: string): Port<T> { ... }

// In an interpret handler:
interpret: {
  announce: async (cmd, ctx) => {
    ctx.emit(cursorPort, { text: cmd.line, polite: true });
    // ↑ outgoing port emit. No Msg returned.
  },
}

// On the host:
const cleanup = runtime.subscribePort(cursorPort, (announcement) => {
  liveRegion.textContent = announcement.text;
});
```

Why we built this even though Elm-style ports work over chrome.runtime.sendMessage:
the **State / Observe / Port** triangle is the substrate's typed escape
hatch story.

- **State** — the world the program models. Folding "I just announced X" into
  state turns ephemeral signals into persisted facts (the anti-pattern that
  motivated `definePort`).
- **Observe** — every (msg, state) transition. Right channel for devtools and
  logging; wrong channel for one signal.
- **Port** — one typed channel per concept. Subscribers only see emissions
  to *that* channel.

The cursor announcement work (commits `c85f4e55c`, `9e5cee05b`,
`8f4f3fad5`) is the canonical port use case in this repo. The cursor
runtime emits to a `cursorPort` instead of folding announcements into
state — that's how `lastAnnouncement` got killed.

### 2.13 Interop: Custom Elements

Elm guide: `interop/custom_elements.md`.

Elm's pattern for JS widgets-inside-Elm: define a custom element in JS,
use it like an HTML tag in the view. Properties become attributes;
events become Msgs.

Our equivalent: a React component that wraps the JS widget and exposes
props + an `onChange`-style callback. The widget runtime
(`packages/widget-runtime`) is exactly this pattern at scale — a piece of
imperative DOM logic wrapped by a React boundary that surfaces its events
as Msgs to the parent TEA machine.

### 2.14 Interop: Limits

Elm guide: `interop/limits.md`.

Elm enforces "no synchronous JS calls from Elm code, no direct DOM access,
no monkey-patched native modules." The whole interop discipline of Elm is
a long argument for keeping the pure layer pure.

We do *not* have the language enforcing this — TypeScript lets you
`document.querySelector` in the middle of a reducer. The convention is:

- `update` is pure. If you find yourself reaching for `Date.now()`,
  `Math.random()`, `fetch`, or `document` inside it, that's a Cmd you
  haven't named yet.
- `init` is pure modulo the `ctx` arg. Same rule.
- The only place side-effects belong is `interpret` handlers and
  `subscribe` handlers. Those *are* the runtime.

Biome lint enforces purity on files matching reducer / phase globs (the
`Date`, `fetch`, `crypto`, `uuid` ban). For surfaces not yet covered by
lint, reviewers enforce. See `docs/design-patterns.md` (Parse, Don't
Validate; Data Flow — No Side-Channels) and `.patterns/tea/tea-invariants.md`
(invariants 2, 3, 8) for the violation catalogue.

### 2.15 Error handling: Maybe

Elm guide: `error_handling/maybe.md`.

`Maybe a = Just a | Nothing`. The canonical "optional value" type.

We use `T | null`. This is a deliberate departure — `Maybe<T>` would be
faithful but every nullable case turns into ceremony (`Maybe.map`,
`Maybe.andThen`, `Maybe.withDefault`) where idiomatic TS just writes
`x ?? defaultValue` or `if (x !== null)`.

The discipline that matters from this chapter: *every `T | null` in a
parameter signature is a question the schema is dodging.* Elm forces
the question by making `Nothing` a syntactic variant; we do it by review.

See [`docs/design-patterns.md#nullable-is-two-functions-in-disguise`](../design-patterns.md#nullable-is-two-functions-in-disguise) — the rule that catches this at API-design time, before nullable propagates.

### 2.16 Error handling: Result

Elm guide: `error_handling/result.md`.

`Result error value = Ok value | Err error`. Used wherever something can
fail with a *reason* (HTTP, JSON parse, file read).

Direct port — `better-result`'s `Result<E, T>` is structurally identical:

```ts
import { Result } from "better-result";

// constructors
Result.ok(42)            // Ok 42
Result.err("nope")       // Err "nope"

// pattern match
result.match({
  ok: (value) => ...,
  err: (error) => ...,
})

// async lift (try/catch as data, not control flow)
const r = await Result.tryPromise({
  try:   () => fetch(url).then(r => r.json()),
  catch: (e) => toAppError(e),
});
```

Our `tryInterpret` (Section 4.6) is sugar over this. It's the Railway
pattern at the boundary: every Cmd handler is "fallible work, two named
outcomes." See `docs/design-patterns.md` "Railway."

### 2.17 Optimization: `Html.Lazy`

Elm guide: `optimization/lazy.md`.

```elm
view : Model -> Html Msg
view model =
  div [] [ lazy viewBigList model.items ]
```

`lazy viewFn args` says "if `args` haven't changed by reference equality
since last frame, skip both `viewFn` and the diff against last frame's
output." It's referential transparency exploited as a render cache.

Our equivalent is the React pair `useMemo` + `React.memo`:

- `React.memo(Component)` — skip the child's render if props are
  reference-equal.
- `useMemo(() => expensive(arg), [arg])` — cache the result by identity.

Same idea, different mechanism. Elm gets it for free because every value is
immutable; we have to opt in.

### 2.18 Optimization: `Html.Keyed`

Elm guide: `optimization/keyed.md`.

```elm
Keyed.node "ul" [] (List.map (\p -> (p.id, viewItem p)) items)
```

Without keys, virtual-DOM diff has to do a pairwise comparison across the
list. With keys, it matches by id and computes the minimum shuffle.

React `key={item.id}` is the same primitive with the same rules: insertion
/ removal / reorder become cheap; identity-by-position becomes wrong.

### 2.19 Optimization: Asset Size

Elm guide: `optimization/asset_size.md`.

Elm's specific advice (closure compiler advanced mode, `unsafe_comps`)
doesn't transfer — we're not compiling Elm to JS, we're writing TS
directly. The principle does: dead-code elimination at build time matters,
and TEA's "pure code is the bulk of the app" property makes it tractable.

### 2.20 Types: Custom Types, Type Aliases, Pattern Matching

Elm guide: `types/custom_types.md`, `types/type_aliases.md`,
`types/pattern_matching.md`, `types/reading_types.md`.

Direct map:

| Elm | TypeScript |
|---|---|
| `type User = Regular String Int \| Visitor String \| Anonymous` | `type User = { tag: "regular"; name: string; age: number } \| { tag: "visitor"; name: string } \| { tag: "anonymous" }` |
| `type alias Model = { count : Int }` | `type Model = { count: number }` (or `interface Model {...}`) |
| `case msg of Inc -> ... ; Dec -> ...` | `switch (msg.tag) { case "inc": ... }` or chained `if (msg.tag === "...")` |
| `Maybe a` | `T \| null` (see 2.15) |
| `Result e a` | `Result<E, T>` from `better-result` |

The `tag` discriminant is convention — pick a name, use it everywhere in a
codebase. Our codebase uses `type`. (`{ type: "..." }` rather than `{ tag:
"..." }`.) Stay consistent.

`case ... of` in Elm guarantees exhaustiveness — the compiler refuses the
program if you forget a variant. TypeScript gets the same guarantee from
`switch` + `default` with an `absurd()` helper:

```ts
function absurd(x: never): never { throw new Error("unreachable"); }

switch (msg.type) {
  case "inc": return [state + 1, []];
  case "dec": return [state - 1, []];
  default: return absurd(msg);  // compile error if you add a variant and forget
}
```

Reducers in `@demlik/tea` use mapped-type `Reducer<S, M, C>` literals where
the variant set is load-bearing — a missing handler fails to compile, no
`absurd()` needed. Pre-substrate reducers in the repo (widget-engine,
audit-agents) use `absurd()` after a switch to get the same guarantee.

---

## Section 3 — Substrates beyond the browser

Elm's runtime targets one host (the browser, via `elm/browser`). We have
four hosts.

### 3.1 React (`@demlik/tea/react`)

Direct analogue to `Browser.element`. The three rules
(`packages/tea-react/README.md`):

1. The runtime is source of truth, not React state.
   `useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState)`.
2. The runtime is memoized per mount, not per render. Deps are *identity* —
   `[machine, opts.ctx, opts.store]`. A new `ctx` reference rebuilds the
   runtime. **Memoize `ctx` with `useMemo` at the call site.**
3. Concurrent React is the design target — that's why
   `useSyncExternalStore`, not the older `useState`-+-`useEffect` pattern.

```ts
import { useMachine } from "@demlik/tea/react";

function CounterPage() {
  const ctx = useMemo(() => ({ random: cryptoRandom }), []);
  const [state, dispatch] = useMachine(counterMachine, { ctx });
  return <button onClick={() => dispatch({ type: "inc" })}>{state.count}</button>;
}
```

`useRuntime` is the escape hatch when something *else* owns the runtime
(parent component, test harness, singleton). The component does *not*
call `runtime.stop()` on unmount in that case.

### 3.2 Chrome extension (`@demlik/tea/extension`)

Chrome extensions are three independent JS contexts: background service
worker, content script (per tab), and surface pages (popup, sidepanel,
options). They share nothing. Elm has nothing for this.

The bridge:

```
  background (host)                      sidepanel (surface)
  ┌──────────────────┐                   ┌────────────────────┐
  │ bridgeRuntime    │ chrome.runtime.*  │ useBackgroundRuntime│
  │ ├ observe→broadcast ──────────────▶  │ ├ hydrate (initial) │
  │ └ onMessage (hydrate, dispatch) ◀── │ └ dispatch (msgs)   │
  └──────────────────┘                   └────────────────────┘
```

Wire shape (one channel string, three message types):

```
{ type: channel,                msg, state }   // background → surfaces (broadcast)
{ type: `${channel}:hydrate`  }                 // surface → background (request)
{ type: `${channel}:dispatch`, msg }            // surface → background (input)
```

Three constructors:

- `bridgeRuntime(runtime, { channel })` — wraps a runtime in the
  background; returns a cleanup. Every transition broadcasts; every
  surface message dispatches.
- `bridgeClient<S, M>({ channel })` — surface-side; speaks
  `chrome.runtime.sendMessage`.
- `bridgeTabClient<S, M>({ tabId, channel })` — service-worker-side
  client of a *content-script*-hosted runtime; speaks
  `chrome.tabs.sendMessage(tabId, ...)` and filters incoming broadcasts
  by `sender.tab?.id`.

This is closer to Elm's `port module` than to anything else in Elm — the
boundary is well-typed, errors are fire-and-forget, the wire shape is
declared once.

### 3.3 Durable Objects (`@demlik/tea/do`)

Cloudflare Durable Objects are server-side, persistent JS contexts with
storage, alarms, and websockets. The DO is the canonical place to put a
long-running TEA machine — an audit run, an orchestrator.

Two pieces:

- `doStore(storage, key?)` — `Store<S>` over `DurableObjectStorage`.
  JSON-stringifies on save; `null` on missing key.
- `doSubscribe()` — handler registry for two Sub variants:
  - `do_alarm` — `{ id, type: "do_alarm", firesAt: epochMs, msg }`. The
    runtime reconciles alarms via `ctx.state.storage.setAlarm(firesAt)`,
    and the DO's `alarm()` callback dispatches the registered msg by
    looking up the registry by id.
  - `do_ws` — `{ id, type: "do_ws", socketId, msg: (data) => Msg }`.
    The DO's `webSocketMessage(ws, data)` callback dispatches matching
    `socketId`s.

The key TEA insight here: **alarms and websockets are Subs, not ad-hoc
state.** Elm's Time chapter (2.9) is the same insight applied to
`setInterval`. The DO context just gives us a different timer source.

The audit-agents work that needs reframing
(`memory/project_audit-agents-state-framing.md`) is asking exactly this
question — DO's in-memory graph state is currently invisible to the
substrate; making it a `Model` and the DO's alarm a `Sub` is the fix.

### 3.4 Pluggable storage (`@demlik/tea/mem`)

In-memory `Store<S>`. The default for tests. Reference semantics, not
deep-clone — matches what an in-memory cache obviously does and avoids
a JSON round-trip on every test save.

```ts
const store = memoryStore<Model>({ count: 0 });
const runtime = run(machine, { ctx, store });
```

### 3.5 Domain library: `@demlik/tea/work-queue`

A work queue is a near-universal substrate need. `tea-work-queue` is
substrate-agnostic by construction: it takes a `Store<QueueItem<I, O>[]>`
and exposes `enqueue`, `claimNext`, `markDone`, `markFailed`, etc.

```ts
const queue = createQueue<AuditInput, AuditId>(store);
await queue.enqueue({ url: "...", journeyId: "..." });
const next = await queue.claimNext();  // marks status = "running"
await queue.markDone(next.id, ...);
```

The pure ops in `packages/tea-work-queue/src/ops.ts` are testable in
isolation; the adapter binds them to a Store.

### 3.6 Inspector: `@demlik/tea/devtools`

Three pieces, all presentational, all decoupled from the runtime:

- `<StateInspector state flashKey?>` — JSON state viewer.
- `useMsgHistory(dispatch, max?)` — records every Msg through a wrapped
  dispatch.
- `<MsgLog history>` — list view.

The deliberate constraint: the package does NOT take a Runtime. State and
history are props. You wire it: from `useMachine`, from an
externally-built runtime, from a test harness. Same shape as Elm's
debugger but optional, swappable, and not in the critical path.

---

## Section 4 — What we have that Elm doesn't

Five primitives in `@demlik/tea` that have no direct Elm analogue. Each
exists because the host story (CF, chrome, React 18) needed it and the
substrate is the right place to put it.

### 4.1 `Port<T>` — typed selective output

Already covered in 2.12. Elm has ports but they live at the program
boundary (declared in a `port module`); ours are first-class values you
pass around. Identity-by-reference, not by name. The cursor announcement
work is the canonical use case.

### 4.2 `observe(msg, state)` — every-transition trace

```ts
const off = runtime.observe((msg, state) => devtools.append({ msg, state }));
```

Elm's debugger is bolted on. Ours is a first-class runtime surface. Same
contract as the (now-archived) `elm-debugger`: every completed transition
fires (including the boot transition where `msg` is `null`), every fire
is throw-isolated.

Distinct from `subscribe(listener)` because the contracts differ. React
consumers want "something changed, re-read state"; devtools consumers
want "here is the exact (msg, state) pair, append it."

### 4.3 `tryInterpret` — Railway sugar over Cmd handlers

```ts
interpret: {
  http_get: tryInterpret(
    async (cmd, ctx) => fetch(cmd.url).then(r => r.text()),
    (text, cmd) => ({ type: "got_text", text }),
    (err, cmd) => ({ type: "http_failed", error: toAppError(err) }),
  ),
}
```

Wraps `Result.tryPromise`. Guarantees the handler resolves with an Ok-Msg
or an Err-Msg, never rejects. This is the boundary where Elm's `Result e
a` lives and our type system catches up.

### 4.4 `Store<S>` — pluggable persistence

```ts
interface Store<S> {
  load(): Promise<S | null>;
  save(state: S): Promise<void>;
}
```

Elm doesn't have this because Elm doesn't persist. We do (DO storage, chrome
storage, in-memory). Same Machine, different Store, different lifetime.

### 4.5 `enqueueDispatch` serial gate

The runtime is a single concurrency gate: every dispatch waits for the
previous step (reducer + save + reconcile + interpret) to fully resolve.
Re-entrant dispatches from inside `interpret` or `subscribe` go through
the same gate — they queue on the tail. This is the property that lets
the substrate guarantee:

- Save-before-effects is the hard ordering.
- Throws from `update` propagate immediately; state unchanged.
- Throws from `save` propagate AFTER in-memory state advances (PRD row:
  "state advanced; persisted state did not").
- Throws from `reconcile` or `interpret` propagate AFTER save succeeded.
- A single failing dispatch does NOT poison the tail (the rejection is
  swallowed on the tail; only the original caller's promise rejects).

Elm's runtime gives the same guarantee implicitly. Our runtime gives it
explicitly so it can be tested.

### 4.6 Throw-isolation discipline

Listeners, observers, port subscribers, sub cleanups: a single bad
consumer cannot strand the others. Throws are caught at the fanout site,
`console.error`'d, and the next consumer runs. This is *not* "fail
silently" — the dispatch promise still reflects the underlying outcome,
the trace is still logged. It's "one bad subscriber doesn't break a
hundred good ones."

---

## Section 5 — What Elm has that we don't (yet)

Deliberate non-goals and known gaps. The list is short.

| Elm has | We have | Status |
|---|---|---|
| Compile-time totality on `update` | `absurd(x: never)` convention | **Gap.** Replace `default: return state` with `absurd(msg)` as you touch reducers. |
| `Cmd.map` / `Sub.map` for parent-child composition | Flat Cmd / Sub union per machine | **By design.** TS discriminated unions are cheap; flat unions outperform the nested-component story most of the time. Revisit if we ever ship a generic page-router. |
| `Task` algebra (chained deferred effects) | Compose Promises inside `interpret` | **By design.** Task exists to dodge Elm's purity; we don't need it. |
| `Browser.application` URL routing | Next router + Relay route params | **By design.** TEA owns fragments; routing owns the URL. |
| `Browser.document` `<title>` control | DOM-imperative outside the machine | **Gap.** Title sync is fine as-is; if it ever becomes a TEA-managed concern it's a Port. |
| `Html.Lazy` referential-transparency cache | `React.memo` + `useMemo` | **Equivalent.** Different mechanism, same property. |
| Effect managers (custom Cmd / Sub backends, à la `elm/random`'s internals) | Direct handler registry in `interpret` / `subscribe` | **By design.** Effect managers were removed from public Elm for a reason — they're too easy to misuse. Our registry is the simpler version. |
| Time-travel debugger | `@demlik/tea/devtools` + `observe` | **Equivalent.** Replay-from-history is a few lines of host code on top. |

---

## Section 6 — Reading list, in order

Order matters. Each builds on the previous.

1. `architecture/buttons.md` — the simplest possible Model/Msg/update/view.
   Read once, internalize the rhythm.
2. `architecture/text_fields.md`, `architecture/forms.md`,
   `architecture/checkboxes.md`, `architecture/radio_buttons.md` — variants
   of the same pattern. Read for the "reusable views vs components" point
   in `checkboxes.md`.
3. `effects/README.md` — why `Cmd` and `Sub` exist. The picture diagram
   (`element.svg`) is the whole architecture in one image; it's worth
   recreating in our internal docs.
4. `effects/http.md` — `init` with an initial Cmd; `Result` for failures.
5. `effects/json.md` — decoders as Parse-Don't-Validate. Map to zod in
   your head as you read.
6. `effects/random.md`, `effects/time.md` — Cmd and Sub variants.
7. `types/custom_types.md` — variant types are *the* design tool.
8. `types/reading_types.md` — for anyone porting Elm signatures.
9. `error_handling/result.md` — Railway-as-data.
10. `webapps/structure.md` — "Do Not Plan Ahead." The single most useful
    page if you're growing a TEA app.
11. `webapps/modules.md` — parent/child composition. Read with caveat
    (we use flat unions per machine; see 2.10).
12. `interop/ports.md` — the canonical inspiration for `Port<T>`.
13. `interop/flags.md` — context-injection at boot.
14. `interop/custom_elements.md`, `interop/limits.md` — the discipline
    chapter.
15. `optimization/keyed.md`, `optimization/lazy.md` — render-cache primitives.

Then, in this repo:

- `docs/design-patterns.md` — Elm Architecture as one of the named patterns.
- `packages/tea/src/index.ts` — the substrate. ~580 lines, every line
  documents its decision. Read top to bottom once.
- `packages/tea-react/README.md` — the React adapter rules + ctx-identity
  footgun.

External, deeper:

- Evan Czaplicki, "[The Life of a File](https://www.youtube.com/watch?v=XpDsk374LDE)"
  — pairs with `webapps/structure.md`.
- Evan Czaplicki, "[The Hard Parts of Open Source](https://www.youtube.com/watch?v=o_4EX4dPppA)" —
  why effect managers were removed from public Elm.
- "[Blazing Fast HTML, Round Two](https://elm-lang.org/news/blazing-fast-html-round-two)"
  — `elm-lang.org` post explaining the render pipeline.

---

## Section 7 — Anchor table for code review

When reviewing TEA code in this repo, this is the checklist.

| Symptom | Pattern violated | Fix |
|---|---|---|
| `let foo: T \| null = null` at module scope | Module-level mutable state | Lift to Model variant |
| `default: return state` in a reducer switch | Missing exhaustiveness | `default: return absurd(msg)` |
| `loading: boolean` next to `result?: T` | "Make impossible states impossible" | `type Phase = { type: "loading" } \| { type: "success"; result: T } \| { type: "failure" }` |
| `try { await fetch(...) } catch` inside `update` | Side effect in pure code | Lift to a `Cmd`, handle in `interpret` |
| `setTimeout` / `setInterval` inside `update` or `interpret` | Effect that should be reconciled | `Sub` variant; let runtime own the lifecycle |
| Fold "I just announced X" into Model | Ephemeral signal as persisted fact | `Port<T>` |
| `observe` consumer filtering for one Msg variant | Wrong channel | `Port<T>` |
| Parent reaches into child's Model | Composition leak | Lift state up; child takes props + onChange |
| `Cmd` handler returns nothing on failure | Silent failure | `tryInterpret` with two Msg outcomes |
| Same `Sub.id` across reconciliation, different behavior | Identity drift | Emit a new id when behavior changes |
| `subscribe` handler with side-effectful setup but no cleanup | Leaked subscription | Return cleanup function from `subscribe[type]` |

---

## Appendix A — Glossary

| Term | Elm | `@demlik/tea` |
|---|---|---|
| Model / State | `type alias Model` | `S` generic on `Machine<S, ...>` |
| Msg | `type Msg = ...` | `M` generic on `Machine<..., M, ...>` |
| Update | `update : Msg -> Model -> (Model, Cmd Msg)` | `update: (state: S, msg: M) => [S, readonly C[]]` |
| View | `view : Model -> Html Msg` | A React component reading state via `useMachine` |
| Cmd | `Cmd msg` value | `{ type: "..." }` tagged variant; handler in `interpret` |
| Sub | `Sub msg` value | `{ id: "...", type: "..." }`; handler in `subscribe` |
| Port (outgoing) | `port sendFoo : Foo -> Cmd msg` | `Port<Foo>` + `ctx.emit(port, value)` |
| Port (incoming) | `port onFoo : (Foo -> msg) -> Sub msg` | `Sub` variant that dispatches `Foo` |
| Flag | `Browser.element { init = init }` arg | `ctx` arg to `init(loaded, ctx)` |
| Loaded state | n/a | `loaded: S \| null` arg to `init` |
| Effect manager | (removed from public Elm) | Handler registry in `interpret` / `subscribe` |
| Runtime | The Elm runtime system | `Runtime<S, M>` from `run(machine, opts)` |
| Lazy | `Html.Lazy.lazy` | `React.memo` + `useMemo` |
| Keyed | `Html.Keyed.node` | React `key` prop |

---

## Appendix B — Source files indexed during canon authoring

The canon was synthesized against:

- `evancz/guide.elm-lang.org` — book/architecture/*, book/effects/*,
  book/error_handling/*, book/interop/*, book/optimization/*,
  book/webapps/*, book/types/*, book/core_language.md.
- `evancz/elm-architecture-tutorial` — README.md, examples/01-08.
- `elm/elm-lang.org` — pages/docs/from-javascript.elm, news posts
  (farewell-to-frp, blazing-fast-html-round-two, compilers-as-assistants,
  interactive-programming, the-perfect-bug-report).
- This repo — `packages/tea/src/index.ts`,
  `packages/tea-react/src/index.ts`, `packages/tea-react/README.md`,
  `packages/tea-extension/src/{index,bridge,react}.ts`,
  `packages/tea-do/src/index.ts`,
  `packages/tea-work-queue/src/{index,ops}.ts`,
  `packages/tea-mem/src/index.ts`,
  `packages/tea-devtools/src/index.ts`,
  `docs/design-patterns.md`.

Re-cloning the upstream sources is two commands:

```bash
git clone --depth 1 https://github.com/evancz/guide.elm-lang.org.git
git clone --depth 1 https://github.com/evancz/elm-architecture-tutorial.git
git clone --depth 1 https://github.com/elm/elm-lang.org.git
```

If anything in this document disagrees with the upstream chapters, the
upstream is the authority — open a PR against this file.
