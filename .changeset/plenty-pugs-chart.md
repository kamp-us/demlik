---
"@demlik/tea": minor
---

Add `./chart` (**experimental**): author a machine as data — one `defineChart` value holding `ctx`, the event alphabet, the Cmd alphabet and the states grouped by phase — and `compile` it into a real `Transitions` table that drops into `defineMachine` with no cast. The State/Msg/Cmd unions, the entry state, the `was` field on parking states and the mermaid drawing are all derived from that one value, so the types, the runtime table and the diagram cannot drift apart.

The point is that the config form keeps full narrowing, which is what config-authored machines normally give up. Guards, Cmd builders and cells are typed by scanning the graph for the edges that reference them: a guard used only at `review.FAIL` receives exactly the `review` state and the `FAIL` message, and one used at two sites receives a third `at` argument carrying the site tag, so a single `switch (at)` narrows the state and the message together. Totality is enforced — every (state, event) pair is declared or explicitly refused, with the event's `scope` quantifying the refusal instead of enumerating it — and the diagnostic names the open pair and every way to close it.

For transitions a declarative edge cannot express, `{ to: [...], cell: "name" }` lets code pick the next state from a set the chart still declares and draws, which is what lets a retry ladder, circuit breaker, cache or rate limiter compose inside a chart. `foreign: true` keeps a library-minted Msg's name bare under namespacing, so N instances of one chart can share a dispatch surface. `defineReducerChart` / `compileReducer` are the flat, msg-keyed form for machines with no phase dimension; they trade away the per-state refusal in the drawing.

New subpath, additive only; no existing behaviour changes. Experimental tier — no stability promise yet.
