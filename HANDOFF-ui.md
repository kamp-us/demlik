# HANDOFF — from the lane-UI pass (`can/fix-ui`)

Five things this pass could not land, because they live in files another agent
owns. Each one is a fix I would otherwise have made; the exact change is here.

---

## 1. SEV2 — every guard preview on a LIVE lane is evaluated against a state with no ctx

`src/chart/lane/inspect.ts:290`

```ts
const events = inspectState(
  desc,
  { type: state.type, was: state.was },   // ← the ctx is dropped here
  optsFor?.(taskId),
);
```

`previewGuardOn` calls `fn(state, msg, at)`. A real guard is over the region's
ctx — fabrika's own is `retriesRemaining: (s) => s.retries < s.maxRetries` — so
with `retries`/`maxRetries` stripped it reads `undefined < undefined`, returns
`false`, and **every guarded control on every live lane shows its `otherwise`
arm**. A task at `review` with 0 of 2 retries spent tells the reader that `FAIL`
lands on `frozen`. It is the same class as the scrubbed-dispatch bug: a control
stating an outcome that is not the outcome.

Fix (one line):

```ts
const events = inspectState(desc, { ...state }, optsFor?.(taskId));
```

`TaskState` is `{ type, retries, maxRetries, was? }`, so `{ ...state }` is a
superset of what is passed today and nothing narrows.

My half is already done: `liveFeed`'s `leavesAt` now spreads the running
region's whole leaf into the `LaneLeaves` entry (`view.ts`), so the region's own
ctx is *there* to be handed on. Until the line above changes, it is carried and
then thrown away one call later.

`view.test.ts`'s guard-polarity test is written around this — it uses a guard
over the MSG, which does reach the preview — so it pins `outcomeOf`'s `[guard]`
/ `[!guard]` rendering without depending on the bug either way.

## 2. SEV3 — `defineLane` lowers away every edge's `cmd`

`src/chart/lane/structure.ts` (the lowering) and `src/chart/report/workflow.ts`
(`ImportedEdge`).

`ImportedEdge` has three shapes and none of them has a `cmd` slot, so lowering a
`defineChart` literal that declares `WIP: { target: "build", cmd: "spawn_shell" }`
produces `{ target: "build" }`. Every downstream reader is fine with cmds —
`readEdgeCore` reads `edge.cmd`, `EventPreview` carries `cmds`, and `outcomeOf`
renders `→ build / spawn_shell` — so the effect is that a lane page can never
tell a reader what a click will FIRE, only where it will land. On the typed door
that information existed and was dropped in translation.

Fix: add `readonly cmd?: string | readonly string[]` (and `otherwiseCmd`) to
`ImportedEdge`, and carry them through the lowering. `chartFromWorkflow` needs no
change — a `workflow.json` declares none, so the field is simply absent there.

## 3. SEV3 — the highlighted node should carry polarity in `chartMermaid`

`src/chart/compile.ts:836`.

`opts.polarity` draws the two endings apart by STROKE (`teaTripped` dashed,
`teaShipped` thick) and then `opts.highlight` paints the current node with a
blue FILL on top — so an error final and a success final are the same picture at
the exact moment one of them is where a task died.

I fixed this in the lane's drawing seam (`view.ts`'s `drawLit` appends a
`classDef`/`class` pair painting an error-final current node red, which the
lane's own tests pin and which you can see on `#5674`). The right home is
`chartMermaid`: when `highlight` names a node whose `end === "error"` and
`polarity` is on, emit the red `classDef` instead of the blue one. When that
lands, delete `drawLit` and `ERROR_ACTIVE_CLASS` from `view.ts` — the seam
comment there says so too.

## 4. SEV4 — `<ChartInspector>`'s affordances are inverted and its samples clip

`src/chart/inspect/react.tsx` + `src/chart/inspect/styles.css`. Seen on the
harness's `#inspector` route:

- the two CLICKABLE events (`WIP`, `BLOCKED`) render as plain text while the
  four DISABLED ones get a dotted-bordered box — the only things you can click
  look like labels. This is the same bug the lane sheet had; the lane's fix is
  in `lane/styles.css` under "THE THING YOU CAN CLICK LOOKS LIKE THE THING YOU
  CAN CLICK" and transplants directly: the button keeps border + raised
  background while it is pressable and loses the chrome (never the text) when it
  is not.
- a sample payload renders as `{"at":3,"reason":"review` — one line, no wrap, no
  scroll cue. `.tea-ci-sample` wants `white-space: pre-wrap; overflow-x: auto`
  or a `max-height` with a scroll.

Also from the mutation reviewer: `UI-02`, the same surviving `key={view.mermaid
(shown)}` mutation on `inspect/react.tsx`'s `<pre>`. The lane's kill is
`react.test.tsx` › "gives the mermaid host a NEW node every time the drawing
changes" — capture the node, scrub, assert identity changed. It transplants
verbatim.

## 5. FYI — files I edited that are not mine, and why

`describe.ts`'s new `no-edge` refusal kind changed one sentence that three test
files pinned by its old wording. I updated the assertions and nothing else:

- `src/chart/inspect/describe.test.ts` — three cases now expect
  `{ kind: "no-edge", state }` where they expected `out-of-scope` with
  `scope: ["edges"]`, plus one new `explainRefusal` line.
- `src/chart/inspect/live.test.ts` — two `reason.kind` assertions.
- `src/chart/inspect/react.test.tsx` — one `textContent` assertion.

`npx biome check src/chart` reports one pre-existing format error in
`src/chart/compile.ts` (line ~241, a wrapped ternary) that is on the branch base
and not mine to touch. `npx biome check src/chart/lane src/chart/inspect` is
clean.
