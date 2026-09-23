# @demlik/tea/paginate

> the pagination batteries: the cursor walk as pure state, and the resumable end-to-end traversal built over it.

```ts
import { … } from "@demlik/tea/paginate";
```

## Exports (24)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `createPaginatedWalk` | Function | Build a paginated-walk knob from `config`. |
| `deadlinesSub` | Function | Re-export the deadline primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `deadline` runner, `deadlinesSub` a machine's `subs` entry, and `deadlineSub` builds the entry both composed wrappers' `subs` list. |
| `DeadlinesSub` | Type | The running `"deadline"` Sub: its `deps` is the non-empty list of deadlines to arm. |
| `deadlineSub` | Function | Re-export the deadline primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `deadline` runner, `deadlinesSub` a machine's `subs` entry, and `deadlineSub` builds the entry both composed wrappers' `subs` list. |
| `DeadlineSub` | Type | One deadline, as a battery lists it. |
| `defaultPaginatorPolicy` | Variable | Sensible defaults: start from a numeric offset of `0`, pause after 1000 un-drained items. |
| `drain` | Function | Acknowledge that the consumer finished processing `n` items, lowering the backpressure gauge. |
| `FetchPageCmd` | Type | The page-fetch effect this knob emits: the inherited `resilient_run` Cmd from resilient-call, whose `input` is the `Cursor` to fetch and whose `key` is the fixed `PAGE_KEY`. |
| `initPaginator` | Function | The starting state: idle, nothing seen, no pages recorded. |
| `isDone` | Function | Whether the walk has finished (the API returned a null next cursor). |
| `liftWalk` | Function | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.walk`. |
| `PAGE_KEY` | Variable | The single resilient-call key every page fetch runs under. |
| `PageErrMsg` | Type |  |
| `PageOkMsg` | Type | Page-settled Msgs the `handlers` port dispatches back (inherited verbatim). |
| `PaginatedWalkConfig` | Interface | The paginated-walk knob. |
| `PaginatedWalkPorts` | Interface | Ports the consumer supplies to `handlers`. |
| `PaginatedWalkState` | Interface | The slice. |
| `PaginatedWalkTimerMsg` | Type | The retry / deadline timer Msg — inherited from resilient-call. |
| `PaginatorPolicy` | Interface | Paginator policy — pure configuration, no mutable state. |
| `PaginatorState` | Type | The walk's phase. |
| `recordPage` | Function | Record the result of the outstanding fetch and decide what comes next. |
| `resume` | Function | Re-open the backpressure valve after a `drain`. |
| `start` | Function | Arm the first fetch. |
| `subscribeDeadline` | Variable | The `deadline` runner for the DEFAULT `setTimeout` backing. |
