# TEA Invariants — the authority

The eight properties that make a system a TEA system. Every substrate
change in `@demlik/tea` and every consumer machine in the repo must
preserve all eight.

This document is the **citation authority** for PRs touching the substrate
or any reducer / interpret / subscribe surface. Commit messages cite the
invariant strengthened or preserved:

```
feat(tea): SubId branded type [invariant 7]
```

`elm-canon.md` is **prior art**, not authority — it shows how Elm
expressed these invariants in its language. We express them in TS,
sometimes more strictly than Elm could (mapped types, branded primitives,
template literal unions). Read the canon for context; cite this doc for
correctness.

If a substrate change strengthens no invariant on the list, it does not
ship. If a real TEA property is missing from this list, the list is
wrong — open a PR against this file first.

---

## How to read each entry

Every property follows the same shape:

- **The property** — one sentence.
- **Forbids** — a concrete code example that violates it.
- **Permits** — a concrete code example that honours it.
- **Enforcement today** — substrate / lint / review (the weakest link).

The weakest enforcement column is where work goes next. Anything marked
"review" is a future hardening target.

---

## Invariant 1 — State is a value, not a place

State is an immutable value passed through functions. Never a mutable
bag of references, never a module-scoped variable, never a hidden
singleton "the store knows."

**Forbids**

```ts
// at module scope
let currentState: State = initial;

function update(msg: Msg) {
  currentState = { ...currentState, n: currentState.n + 1 };  // mutating "place"
}
```

**Permits**

```ts
function update(state: State, msg: Msg): [State, Cmd[]] {
  return [{ ...state, n: state.n + 1 }, []];  // returning the next value
}
```

**Enforcement today**

- Substrate: `Machine.update` signature requires a returned `[S, C[]]`.
- Review: module-level `let` in machine files. (Future: lint rule.)
- Review: `store.save` is called by the runtime, not by the reducer.

---

## Invariant 2 — Transitions are pure functions

`update : (State, Msg) → (State, Cmd[])`. Same inputs always produce
the same outputs. No I/O. No `Date.now()`. No `Math.random()`. No
mutation of `state` or `msg`. No `console.log` (debugging is `observe`).

**Forbids**

```ts
function update(state: State, msg: Msg): [State, Cmd[]] {
  const now = Date.now();                    // impure
  return [{ ...state, lastSeen: now }, []];
}
```

**Permits**

```ts
// Time enters as a Sub or Cmd result, never via Date.now in update.
function update(state: State, msg: Msg): [State, Cmd[]] {
  if (msg.type === "tick") return [{ ...state, lastSeen: msg.now }, []];
  return [state, []];
}
```

**Init's rehydrate branch is bound by the same rule.**

`machine.init(loaded, ctx)` returns `[state, []]` (no Cmds) whenever
`loaded !== null`. Init is a state migration / parse boundary on rehydrate,
not a boot-effect hook. Boot effects on rehydrate go through a `boot` Msg
dispatched once after `run(...)` returns; stateless infrastructure that the
machine doesn't own goes at the host module top.

```ts
// Forbids
init: (loaded, ctx) =>
  loaded?.type === "auditing"
    ? [loaded, [{ type: "attach_debugger", tabId: loaded.tabId }]]  // ✗
    : [loaded ?? initial, []];

// Permits
init: (loaded, ctx) =>
  loaded === null ? [initial, []] : [loaded, []];
```

**Note on `Date`** — `Date.now()` and `new Date()` (no args) read current
time and are impure. `new Date("2026-01-15T12:00:00Z")` and
`new Date(epochMs)` construct a known instant deterministically and are
pure. The fold-purity guard (#228) flags the zero-arg `new Date()` and
`Date.now()` reached inside a reducer body (test / helper files excluded);
a constant `new Date("…")` is deterministic and permitted, but the clean
habit is to define it once at module scope as `const FOO_DATE = new
Date("...")` and read the value in the fold.

**Enforcement today**

- Static guard (#228): `packages/tea/src/pure/reducer-purity.ts` +
  `reducer-purity.test.ts` scan production `update` reducer **bodies** for the
  banned id/timestamp mints (`Math.random`, `Date.now`, zero-arg `new Date()`,
  `crypto.randomUUID` / `crypto.getRandomValues`) and id-mint imports (`uuid`,
  `nanoid`), failing the suite with a message that names the call site and the
  fix (move it to `interpret`). Scoped to reducer bodies, so the same call at an
  interpret/config boundary is not flagged; ids/timestamps read from Msg payload
  are permitted.
- Substrate: `update` return type forces a new `[S, C[]]`.
- Substrate: `replay` throws if `init(loaded)` returns non-empty Cmds with
  non-null `loaded` — catches the violation at the first test that runs.

---

## Invariant 3 — Effects describe, don't perform

A `Cmd` is a *value* describing intent: `{ type: "http_get", url, into }`.
The reducer never performs the effect. The runtime, via `interpret`,
performs it and feeds the result back as a `Msg`.

**Forbids**

```ts
function update(state: State, msg: Msg): [State, Cmd[]] {
  fetch("/api/foo").then(...);               // performing
  return [state, []];
}
```

**Permits**

```ts
function update(state: State, msg: Msg): [State, Cmd[]] {
  return [
    { ...state, phase: "loading" },
    [{ type: "http_get", url: "/api/foo", into: GotFoo }],   // describing
  ];
}
```

**Enforcement today**

- Static guard (#228): the fold-purity scan (invariant 2) points every
  banned reducer-body call at `interpret` — impurity handed back as Msg data
  is exactly this invariant. (Extending the banned set to `fetch` /
  `localStorage` is a follow-on.)
- Substrate: `Cmd` is a tagged variant; reducer return is
  `readonly C[]`.
- Type system: `interpret[K]` signature forces async handler shape.

---

## Invariant 4 — External time and events are subscriptions

`setInterval`, websockets, Durable Object alarms, `document` events,
chrome runtime messages: all live as `Sub` variants. The runtime
reconciles the desired set by `id` every transition. Reducers, init, and
interpret handlers never call `setInterval` or `addEventListener` directly.

**Forbids**

```ts
init: (loaded, ctx) => {
  setInterval(() => dispatch({ type: "tick" }), 1000);  // leaked subscription
  return [initial, []];
}
```

**Permits**

```ts
subscriptions: (state) =>
  state.phase === "running"
    ? [{ id: subId("main-tick"), type: "tick", every: 1000, into: (now) => ({ type: "tick", now }) }]
    : [];
```

**Enforcement today**

- Substrate: `reconcileSubs` owns the lifecycle; only `subscribe[type]`
  handlers may install listeners, only their returned cleanup may remove
  them.
- Phase 1.3: `SubId` branded type catches ad-hoc id strings at the type
  level + runtime collision assert.

---

## Invariant 5 — Composition is by reduction, not inheritance

Sub-machines compose by the parent forwarding child Msgs and folding
child state into a field. No class hierarchy, no mixin, no `extends`.
Cmd / Msg unions are typically flat — discriminated unions are cheap.

**Forbids**

```ts
class TodoMachine extends BaseMachine { ... }   // OOP composition
```

**Permits**

```ts
type ParentMsg = { type: "local" } | { type: "child"; msg: ChildMsg };

function update(state: ParentState, msg: ParentMsg) {
  if (msg.type === "child") {
    const [child, cmds] = childUpdate(state.child, msg.msg);
    return [{ ...state, child }, cmds.map(wrapChildCmd)];
  }
  // ...
}
```

**Enforcement today**

- Structural: `Machine<S, M, C, U, Ctx>` is an interface, no class
  hierarchy in the substrate.
- Review: parent/child wrapping convention (`ChildMsg`-as-variant).
- Phase 2.2: `composeInterpret(a, b)` makes effect-dictionary composition
  explicit.

---

## Invariant 6 — Runtime is small and inspectable

Every transition is observable. The runtime exposes `subscribe`,
`observe`, `subscribePort`, `getState`, `ready`. No hidden queue, no
private bus, no monkey-patched globals. Boot is a named, awaitable
moment.

**Forbids**

```ts
class Runtime {
  private queue: Msg[] = [];   // hidden state, no introspection
  private async tick() { ... }
}
```

**Permits**

```ts
runtime.observe((msg, state) => devtools.append({ msg, state }));
await runtime.ready;            // boot is a named promise
runtime.subscribePort(cursorPort, (announcement) => liveRegion.textContent = announcement.text);
```

**Enforcement today**

- Substrate: `Runtime<S, M>` interface declares the full public surface.
- Substrate size: `packages/tea/src/index.ts` ≤ 700 LOC, every line
  documents its decision.
- Phase 1.2: `runtime.ready: Promise<void>` closes the v1 boot-await
  gap.

---

## Invariant 7 — Identity is explicit

Variant tags (`type: "tick"`), sub ids (`subId("main-tick")`), port
brands (`Port<T>`). Identity is never positional, never inferred from
string equality alone, never reflective. The type system or a runtime
assert catches collisions; nothing is silent.

**Forbids**

```ts
type Msg = string;                                       // identity by raw string
const subs = [{ id: "tick", ... }, { id: "tick", ... }]; // silent collision
```

**Permits**

```ts
type Msg = { type: "tick"; now: number } | { type: "reset" };
const subs = [
  { id: subId("main-tick"), type: "tick", every: 1000, into: ... },
  // SubId brand makes typos compile-fail; reconcileSubs asserts no
  // (same id, different type) within the desired set.
];
```

**Enforcement today**

- Substrate: discriminated unions for Msg / Cmd / Sub. `Port<T>` is a
  branded object — identity by reference, not by name.
- Phase 1.3: `SubId` branded type + runtime collision assert.
- Phase 1.1: `Reducer<S, M, C>` and `Transitions<S, M, C>` mapped types
  make the variant set load-bearing — adding a Msg without a handler
  fails to compile.

---

## Invariant 8 — The boundary parses; the core trusts

Raw `unknown` from `fetch`, storage, `postMessage`, database rows,
chrome runtime messages: all parsed at the substrate boundary. By the
time a Msg reaches `update`, its payload is the domain type. No
`as any`, no `Quote.parse(...)`, no schema validation inside the
reducer.

**Forbids**

```ts
function update(state: State, msg: Msg) {
  if (msg.type === "got_data") {
    const parsed = Quote.parse(msg.raw);    // parsing inside reducer
    return [{ ...state, quote: parsed }, []];
  }
}
```

**Permits**

```ts
interpret: {
  http_get_quote: tryInterpret(
    async (cmd, ctx) => fetch(cmd.url).then((r) => r.json()),
    (raw, cmd)  => cmd.into(Result.ok(Quote.parse(raw))),   // parse at boundary
    (err, cmd)  => cmd.into(Result.err(toHttpError(err))),
  ),
}
```

**Enforcement today**

- Substrate: `tryInterpret` Railway sugar at every Cmd boundary.
- Review: no `as` casts or `as any` inside `update` or `subscriptions`.
- Substrate: `Store<S>.load()` returns `unknown`; required `migrate(raw)`
  parses at the boundary — same shape as `tryInterpret` for Cmd
  boundaries. Adapters that cross real serialization boundaries
  (`chromeStorageStore`, `doStore`) require an explicit parse function;
  `memoryStore` permits a default-identity parse because it is a
  degenerate same-process boundary.
- Phase 2.1: `Cmd` carries its own zod schema; substrate parses before
  the Msg lands. Promotes boundary parsing from convention to substrate
  property.

---

## Citation gate — how PRs use this doc

**Every PR touching the substrate, a reducer, an interpret handler, or
a subscribe handler MUST:**

1. Cite the invariant(s) strengthened or preserved in the commit
   message, e.g. `[invariant 2, 7]`.
2. If the change does not strengthen or preserve any invariant, the
   change does not ship.
3. If the change expresses a TEA property not on this list, the list is
   wrong — PR against this file first.

**Examples of well-cited commit messages:**

```
feat(tea): SubId branded type + collision assert [invariant 7]
feat(tea): runtime.ready Promise<void>           [invariant 6]
feat(tea): Reducer<S,M,C> mapped type            [invariant 2, 7]
feat(eslint): purity rule on reducer files       [invariant 2, 3]
```

**Examples of bad citations (would be rejected):**

```
refactor(tea): cleaner reducer signature              ← no invariant cited
feat(tea): add Transitions type [canon §1, §2.5]      ← cites prior art instead of invariant
fix(tea): handle edge case in interpret               ← which invariant?
```

---

## Relationship to `elm-canon.md`

| Doc | Role |
|---|---|
| `tea-invariants.md` (this file) | **Authority.** What every change must preserve. |
| `elm-canon.md` | **Prior art.** How Elm expressed these invariants in its language; useful for grounding design, not for judging correctness. |
| `hardening-roadmap.md` | **Plan.** Sequence of changes; each cites invariants here. |

Use the canon to understand the why behind an invariant. Use this doc
to judge whether a proposed change keeps the system TEA.

---

## Why exactly eight

The list is closed at eight by design. Each is a *deep* property of
stateful systems — not a coding-style preference, not a TS idiom, not a
performance tip. Adding a ninth requires showing it is independent of
the existing eight; removing one requires showing the system survives
without it.

History of the list lives in the `decisions.md` companion in the vault
feature folder. The eight here are the load-bearing ones that survived
the audit.
