# @demlik/tea/paginate

> the pagination batteries: the cursor walk as pure state, and the resumable end-to-end traversal built over it.

```ts
import { … } from "@demlik/tea/paginate";
```

## Exports (18)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `createPaginatedWalk` | Function | Build a paginated-walk knob from `config`. |
| `defaultPaginatorPolicy` | Variable | Sensible defaults: start from a numeric offset of `0`, pause after 1000 un-drained items. |
| `drain` | Function | Acknowledge that the consumer finished processing `n` items, lowering the backpressure gauge. |
| `FetchPageCmd` | Type | The page-fetch effect this knob emits: the inherited `resilient_run` Cmd from resilient-call, whose `input` is the `Cursor` to fetch and whose `key` is the fixed `PAGE_KEY`. |
| `initPaginator` | Function | The starting state: idle, nothing seen, no pages recorded. |
| `isDone` | Function | Whether the walk has finished (the API returned a null next cursor). |
| `liftWalk` | Function | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.walk`. |
| `PAGE_KEY` | Variable | The single resilient-call key every page fetch runs under. |
| `PageErrMsg` | Type |  |
| `PageOkMsg` | Type | The page-settled Msgs the engine mints from that handler's outcome. |
| `PaginatedWalkConfig` | Interface | The paginated-walk knob. |
| `PaginatedWalkState` | Interface | The slice. |
| `PaginatedWalkTimerMsg` | Type | The retry / deadline timer Msg — inherited from resilient-call. |
| `PaginatorPolicy` | Interface | Paginator policy — pure configuration, no mutable state. |
| `PaginatorState` | Type | The walk's phase. |
| `recordPage` | Function | Record the result of the outstanding fetch and decide what comes next. |
| `resume` | Function | Re-open the backpressure valve after a `drain`. |
| `start` | Function | Arm the first fetch. |
