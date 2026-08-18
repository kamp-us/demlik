---
"@demlik/tea": minor
---

**`@demlik/tea/chart/lane` — `runLane`'s doors are checked, and its cmd tag
moved.** The runtime drove one lane correctly; what it did with the inputs a
host actually hands it — a persisted state from an older build, a boot that
disagrees with the lane, a task id with a dot in it — was undefined.

**Breaking, one shape.** A region's cmd leaves the lane tagged
`{ lane: { task } }` instead of a flat `task`, so a chart whose cmd payload
declares its own `task` field keeps its value:

```diff
- interpret: { "issue_5729.spawn_shell": async (cmd) => spawn(cmd.task) }
+ interpret: { "issue_5729.spawn_shell": async (cmd) => spawn(cmd.lane.task) }
```

The flat tag was spread OVER the payload, and `task` is an entirely ordinary
field for a cmd in a work lane to carry: the author's value was replaced by the
lane's task id, and the tag narrowed the author's field to that literal, so
there was no type error either. `lane` is now the one key a region's cmd may not
declare, and a chart that declares it is a compile error naming the task
(`__laneRegionCmdDeclaresTheReservedLaneField`). `cmd.type` is unchanged.

- **One retry budget, not two.** `defineLane({ retries })` lands in
  `lane.context[task].maxRetries` and that is the number `foldLane` replays
  with. `runLane`'s budget used to come only from `boot()`, and nothing
  cross-checked them: booting `maxRetries: 0` under a lane that declares the
  default 2 froze the run where the report of that same log said it retried.
  A `boot()` — or a rehydrated leaf — carrying a budget the lane does not
  declare is now refused, naming the task and both numbers.
- **Rehydration is validated.** `init(loaded)` is the branch every production
  restart walks; it used to return its argument unread. A persisted state is now
  checked against the lane on the way in — every task present, no task the lane
  does not run, each leaf's `type` a state of that task's chart, and its `was` a
  state too — instead of failing later as a reducer throw inside the host's
  dispatch loop. The leaves are still returned verbatim; the lane's own standing
  is re-derived, since it is a fact derived from those leaves.
- **`was` is checked at boot, and no longer rewritten on a resume.** The typed
  door refuses a bad `was` in `StateOf`; the imported door had no net at all.
  And a resume now carries `was` through unchanged, which is `stepTask`'s rule —
  the compiled cell re-injects `was` for any landing in a parking state, so with
  two mutually reachable parking states the run and the fold walked the next
  resume to two different STATES. fabrika has one parking state; `runLane` is a
  library.
- **Dots are refused.** Task `a` + event `b.GO` and task `a.b` + event `GO` both
  register the dispatch key `a.b.GO` — last writer wins and one task's event is
  unreachable for the life of the process — and a dotted task id writes a log
  the replayer re-partitions into a task that does not exist. `runLane` throws,
  naming both. (`Total<C>` already banned the dot in a state name and in a
  foreign event name, for the same reason.)
- **A task in `phases` with no chart is a defect, not a skip.** It used to get
  no dispatch keys and no boot check — the one input where `runLane`'s closing
  cast asserted something untrue.

`phases` do not gate dispatch and the module header now says so: a message
addressed to a phase-2 task moves that region while phase 1 is active, exactly
as `foldLane` folds the whole log. Phases sequence the lane's STANDING; they are
not admission control.
