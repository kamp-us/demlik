# HANDOFF — from the `can/fix-runtime` lane (`src/chart/lane/run.ts`)

Everything below needs a file this branch does not own. Each item is the exact
change, not a description of one.

---

## 1. `docs/how-to/describe-a-lane.md` — the cmd tag is nested now (REQUIRED)

`LaneCmd` used to carry a flat `task`; it now carries `lane: { task }`, because
the flat tag was spread OVER the payload and silently replaced a chart's own
`task` field (see the changeset `.changeset/lane-runtime-doors.md`). The doc
still shows the old shape and no longer compiles against the API.

- lines 233–235, inside the `interpret` block:
  `async (cmd) => spawn(cmd.task, cmd.step)` → `async (cmd) => spawn(cmd.lane.task, cmd.step)`
- line 264: "carrying `task: "issue_5729"`" → "carrying `lane: { task: "issue_5729" }`"
- line 300 says `runLane` adds **three** checks about the code; it is now four —
  the fourth is `__laneRegionCmdDeclaresTheReservedLaneField`: a region whose
  cmd payload declares `lane`, which is the one key the tag reserves.

`.changeset/runnable-lane.md` (already published) also shows `cmd.task` in its
example; it is a shipped changelog entry, so leave it and let the new changeset
carry the migration note.

## 2. `src/chart/lane/index.ts` — the module header oversells phases (SEV4)

Lines 9–13 read "a lane has PHASES that run in order". Nothing gates dispatch on
the active phase — a message addressed to a phase-2 task moves that region while
phase 1 is still active — and that is the RIGHT behaviour, because `foldLane`
folds the whole log and a run that refused what a fold accepts is precisely the
drift this module exists to rule out. `equiv-lane-run.test.ts` drives exactly
that case (`["issue_3", "WIP"]` first).

**Recommendation: keep the permissive behaviour, fix the prose.** A gate would
have to be added to `foldLane` too — and it cannot be: a fold replays a log of
things that already happened, so refusing an event mid-replay would turn a
historical record into an `UnreplayableLogError` for a lane that genuinely ran.
Suggested wording, after the four bullets:

```
 *   phases are a SEQUENCING of the lane's own standing — which phase is
 *   active, when the lane advances, which ending it reaches — and NOT
 *   admission control over the regions: a message addressed to a later
 *   phase's task moves it, exactly as the fold folds the whole log.
```

`run.ts`'s own header already says this (section "WHAT THE PHASES DO NOT DO").

## 3. `src/chart/lane/equiv-lane-run.test.ts` — its `was` excuse is now stale

Lines 25–30 claim the run and the fold "agree at every site where `was` is
READ". That was FALSE as written: with two mutually reachable parking states the
compiled cell re-injected `was` on a resume and the fold did not, and the next
resume landed the two on different `type`s. It is now TRUE, but by a fix rather
than by luck — `run.ts` carries `was` through a resume unchanged — and the
proof is `lane-runtime.test.ts` ("a resume between two parking states").
Suggested edit: keep the paragraph, replace "The two agree at every site where
it is READ" with "The runtime restores the fold's rule on a resume (`was` is not
rewritten — you are leaving the park, not entering one), so the two agree
field-for-field; `lane-runtime.test.ts` drives the two-parking-state lane that
used to separate them."

Optional but worth it: the `hands` there hand-copy `maxRetries: 5` to match the
lane's `retries: { issue_3: 5 }`. That agreement is now MECHANICAL — `runLane`
refuses a boot that contradicts `lane.context` — so the comment on lines 67–68
can say so instead of describing a coincidence.

## 4. `src/chart/compile.ts` — two notes, no change strictly required

- `buildCell` re-injects `was = st.type` for any landing in a parking state,
  INCLUDING a resume. `run.ts` now undoes that for the resume case, at the lane.
  If compile ever grows a "this edge is a resume" flag at the cell, the cleaner
  fix is to skip the injection there and delete `carryWas` from `run.ts`. Not
  urgent: the lane-side fix is exact and tested.
- **`biome check src/chart` is red on `compile.ts` at this branch's base**
  (formatting only, lines 241–242 of the guard lookup — the formatter wants the
  ternary on one line). It arrived with commit `b767b31`, not with this work.
  Whoever owns `compile.ts` should run `biome check --write` on it.
