---
"@demlik/tea": minor
---

**`@demlik/tea/chart/lane`** — a lane can now be **run**. `runLane(lane, hands)`
returns the `init` and `update` a `Machine` is made of, and `defineMachine`
takes them with no cast.

```ts
const machine = defineMachine<
  LaneRunState<typeof epic>,
  LaneRunMsg<typeof epic>,
  LaneCmd<typeof epic>,
  Sub<never>,
  Record<never, never>
>({
  ...runLane(epic, {
    issue_5729: { parts, boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }) },
    // already merged on GitHub — this instance boots where it IS.
    issue_5730: { parts, boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }) },
  }),
  interpret: { "issue_5729.spawn_shell": async (cmd) => spawn(cmd.task) /* … */ },
});
```

- **Routing** reuses the namespacing that was already there. `compile(chart,
  parts, ns)` keys a table `${ns}.${event}`; the lane's `ns` is the task id, so
  `{ task, event }` is `${task}.${event}` on the wire and a message reaches that
  task's region and no other. The event stays narrowed to the events **that
  task's** chart declares.
- **Per-instance boot.** `boot()` says where THIS instance starts, typed to that
  task's own `StateOf<chart>` — an emitted epic boots each child `queued`,
  `landed` or `frozen` depending on its sub-issue, and `initial: true` becomes
  the default rather than the law. The lane's own standing is derived at boot
  too, so a lane whose children all landed before the run started boots straight
  into `complete` or `tripped`.
- **Phase advancement is the fold's, not a copy of it.** The runtime calls
  `phaseStandings` and the newly-named `laneTerminalReached` — `foldLane`'s own
  functions — so a run and a report of that run cannot drift. `equiv-lane-run
  .test.ts` drives one lane through the runtime and through the fold over the
  equivalent event log and diffs every region's state plus the whole derived
  `deriveLaneStatus` output at every step, over two walks that between them
  cover every declared arm of the region chart.
- **Cmds** leave the lane tagged with the task that emitted them, under the same
  namespace the replies come back in: `issue_5729.spawn_shell`, carrying
  `task: "issue_5729"`.

New exports: `runLane`, `LaneRuntime`, `LaneRunState`, `LaneRegions`,
`LaneRunMsg`, `LaneCmd`, `LaneHand`, `LaneHands`, `LaneHandsOf`,
`LaneRunChecks`; and from `@demlik/tea/chart/report`, `laneTerminalReached` plus
the `LeafStates` the phase walk now takes (`TaskState` still satisfies it — the
widening is what lets the runtime call the same function over its own region
states).

Three more authoring mistakes are compile errors naming the offender: a hand for
a task the lane does not declare, an instance booted into a state its own chart
never declares, and a region whose chart declares a **foreign** event —
`keyOf` leaves a foreign name bare under a namespace on purpose, and a bare
event addresses no single region.
