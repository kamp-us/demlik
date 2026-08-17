---
"@demlik/tea": minor
---

Add `./chart` (**experimental**): author a machine as data — one `defineChart` value holding `ctx`, the event alphabet, the Cmd alphabet and the states grouped by phase — and `compile` it into a real `Transitions` table that drops into `defineMachine` with no cast. The State/Msg/Cmd unions, the entry state, the `was` field on parking states and the mermaid drawing are all derived from that one value, so the types, the runtime table and the diagram cannot drift apart.

The point is that the config form keeps full narrowing, which is what config-authored machines normally give up. Guards, Cmd builders and cells are typed by scanning the graph for the edges that reference them: a guard used only at `review.FAIL` receives exactly the `review` state and the `FAIL` message, and one used at two sites receives a third `at` argument carrying the site tag, so a single `switch (at)` narrows the state and the message together. Totality is enforced — every (state, event) pair is declared or explicitly refused, with the event's `scope` quantifying the refusal instead of enumerating it — and the diagnostic names the open pair and every way to close it.

For transitions a declarative edge cannot express, `{ to: [...], cell: "name" }` lets code pick the next state from a set the chart still declares and draws, which is what lets a retry ladder, circuit breaker, cache or rate limiter compose inside a chart. `foreign: true` keeps a library-minted Msg's name bare under namespacing, so N instances of one chart can share a dispatch surface. `defineReducerChart` / `compileReducer` are the flat, msg-keyed form for machines with no phase dimension; they trade away the per-state refusal in the drawing.

`./chart` itself is a new subpath — experimental tier, no stability promise yet.

**`./poller` has a TYPE-LEVEL BREAKING CHANGE.** The runtime JS is byte-identical; nothing you can observe at run time changed. But making the poller chart draw 16 edges instead of 30 meant narrowing three verbs' declared return types, and a narrowed `.d.ts` is a break for anyone reading them. On 0.x a `minor` is the correct bump for that, but it is not additive, so here is exactly what breaks and what to do:

1. **You implement or mock the `Poller` interface.** `start`, `tickResult` and `tickErr` now declare the phases they actually reach (`PollerPolling`, `PollerPolling | PollerDone`, `PollerPolling | PollerGaveUp`) instead of the whole `PollerState` union, so a stub returning the full union no longer satisfies them. *Fix:* return the narrow arm — every real implementation already did — or import the new `PollerPolling` / `PollerDone` / `PollerGaveUp` types and annotate with those. (`tick` is deliberately NOT narrowed: a generic `tick<S extends PollerState<R>>(state: S) => [S, …]` states an identity no non-generic body can satisfy, and would have made the whole interface unimplementable.)

2. **You `switch` exhaustively on a `tickResult` / `tickErr` result's `phase`.** The arm that can no longer occur — `gave_up` after `tickResult`, `done` after `tickErr` — is now a hard `TS2678` ("type is not comparable"), not a dead-code hint. *Fix:* delete the impossible arm. It was already unreachable; the signature just says so now.

3. **You spell a type as `ReturnType<Poller<R>["tickErr"]>` (or `["start"]` / `["tickResult"]`) and use it as a target type.** That alias is now narrower, so assigning a full-union value into it fails. *Fix:* widen the annotation to `PollerState<R>` where you genuinely hold the union, or narrow the producer.

If none of those three describe your code — you call the poller verbs and read `phase` — this release is additive for you.
