# HANDOFF — from the lane-model branch (`can/fix-model`)

Three findings landed only half-way, because the other half lives in a file this
branch does not own. Each entry says what was done here, what is left, and where.

---

## 1. `lane/run.ts` — a hoisted `hands` object makes the boot marker LIE

**SEV3, reproduced.** Hoisting the hands to a variable without `satisfies` is what
every author does the moment a lane is assembled by a helper. It widens
`boot()`'s return `type` from the literal to `string`, and the marker then fires
naming a task whose boot state is entirely correct:

```ts
const hands = {
  issue_1: { parts: { assign: {} }, boot: () => ({ type: "queued" }) },
};
runLane(epic, hands);
// Property '__laneTaskBootsIntoAStateItsChartDoesNotDeclare' is missing …
// but required in type '{ readonly __laneTaskBootsIntoAStateItsChartDoesNotDeclare: "issue_1" }'
```

`"queued"` IS a state of that chart. The author is told they booted outside the
chart and sent looking at the one thing that is right.

**Done here:** the SPEC half of the same class. A hoisted `terminals` object
without `as const` used to widen `LaneTerminal<L>` to `string` and silently
switch `__terminalCollidesWithAPhase` off; `LaneLiteralAlphabets` now names the
real cause (`__laneTerminalsMustBeLiteralsAddAsConst`, probe `e63`).

**Left, in `lane/run.ts`:** `BootsOutsideItsChart<L, H>` reads
`H[T] extends { readonly boot: () => infer B }` and compares `B` against
`StateOf<chart>`. It needs the same treatment the spec side got: test whether
`B`'s `type` is still a union of literals FIRST, and where it is not, say so —
"this object lost its literal types, add `satisfies LaneHands<typeof lane>`" —
rather than accusing the author of a different mistake. `IsDegenerate` is already
in that file. The marker's own name is the diagnostic, so this is a new marker
ordered ahead of the existing one, not a change to it.

---

## 2. `lane/run.ts` — `LaneRunChecks` does not normalise a NUMERIC hand key

**Follow-on from the numeric-task-id fix.** `structure.ts` now treats a numeric
task key as a key and spells it the way every other layer does — as a string —
so `defineLane({ phases: { 1: { 5729: coder } } })` derives
`LaneTaskId<L> = "5729"`, `laneShape` reports it, the fold folds it, and the
whole alphabet survives (`lane-model.test-d.ts`, `lane-model.test.ts`).

`runLane` takes the hands with the id quoted:

```ts
runLane(numbered, { "5729": hand });   // works
runLane(numbered, { 5729: hand });     // __laneHandNamesAnUnknownTask: 5729
```

**Left, in `lane/run.ts`:** `__laneHandNamesAnUnknownTask` is
`Exclude<keyof H, LaneTaskId<L>>`, and `keyof { 5729: … }` is the NUMBER. It
needs the same `` `${K & (string | number)}` `` normalisation on `keyof H` before
the `Exclude`. Same for `BootsOutsideItsChart`'s `T extends keyof H`. Until then
an unquoted numeric hand key is refused for a reason that is not true — the task
is not unknown, its key is spelled as a number.

---

## 3. `report/report.ts` — `RPT-13`, a surviving mutation

Not a file this branch owns and not in its finding list, recorded so it is not
lost: the mutation reviewer reports that

```
`**${stand.name}:** waiting — …`  →  `**${stand.name}:** ${stand.standing} — …`
```

survives the whole suite. The line renders a phase heading for a phase that is
`"waiting"`, and nothing pins that the literal word is the one that appears —
so the heading could start printing `complete`/`tripped`/`active` for a waiting
phase and the golden would not move. One assertion on the waiting heading, in
`report.test.ts`, closes it. Everything else in `report.ts` is the best-covered
module in the PR (17 of 18 mutations killed); do not re-litigate the rest.
