---
"@demlik/tea": minor
---

Add `./chart/inspect` and `./chart/inspect/react` (**experimental**): a live debugger for any machine authored with `./chart`, that builds itself out of the chart.

A hand-built debugger page for a machine types four things out by hand — the list of messages, the state names, which control is disabled when, and what each payload looks like. A chart already carries all four as data, so `<ChartInspector chart={lane} parts={{ assign, guards }} boot={…} samples={…} />` is the whole page: a control per message, a live state panel, a state diagram with the current node lit, and a time-travel scrubber over every transition. There is no prop that restates something the chart already says.

**Refusals are first-class**, which is the capability the totality property buys and no other inspector can offer. A chart is total over (state × event): a pair is declared, or refused — by the event's `scope`, by the state's `ignore`, or by `end: true` — and there is no third case. So a refused event renders as *visibly refused with the mechanism that refused it* (`"PASS" is not addressed to phase "working" (scope: edges)`), not as a missing button. The refusal reasons are derived by the same predicate `compile` uses to choose between a self-loop and a `NoCellError`, so the picture and the machine cannot disagree about what is refused.

**Guard preview.** Given a live state and a sample message the named guard is executed — it is pure, the same thing `replay` may call — and the branch it takes is reported with that arm's target and cmds. Edit a payload and watch the branch flip. Where it cannot be evaluated (no sample, no bag, a throwing body) it degrades to `unknown` carrying the reason, never to a guess. Cell edges show their whole declared `to` fan-out, plus the target the cell actually picks when it can be run purely with samples, clamped to that edge's `to`.

**Time travel is pure.** The runtime is recorded with `./recorder` and scrubbing re-folds a prefix of the recorded messages through `replay` — `init` + `update` only, never `interpret`, never a Store, never a live subscription — so dragging backwards re-derives history instead of re-performing it.

`./chart/inspect` is the headless half: `describeChart(C)` returns the phases, states, entry, end/parking flags, the event alphabet with `scope`/`foreign`/`hasPayload`, the cmd/guard/cell alphabets, every edge and every refusal; `inspectState(desc, state, opts)` returns one verdict per event against a live state. It is framework-free and pure, so a script, a test or an Ink TUI gets the useful half. `./chart/inspect/react` is the thin binding, styled the way `./devtools` is (one prefixed stylesheet, consumer design tokens, no new dependency).

The one thing the author still supplies is `Samples<C>`: `ty<T>()` is `{}` at runtime, so a payload's shape is erased before any runtime code could read it. The bag is typed by the chart all the same — keyed by exactly the events that declare a payload, each value that event's declared type, an event with no payload has no key to write, and a typo'd name is an excess property.

Additively, `chartMermaid` now takes an optional options bag — `highlight` (light the active node), `phases` (draw phases as Mermaid composite states, which the flat drawing threw away), `direction` and `title`. Every default reproduces the drawing it emitted before options existed, so no existing caller and no committed diagram moves. `safeId` / `safeLabel` are now exported from `./machine-viz` and shared by both drawings, so a chart whose state name is not identifier-safe (`human:cp-approval`) draws correctly instead of emitting broken Mermaid.
