# Run many instances of one chart

To run N copies of one machine over a single dispatch surface — a lane per issue,
a watchdog per job — compile the same chart once per instance with a namespace.
Each instance's own events are keyed `${ns}.${event}`, so instance A's `START` is
not addressable on instance B, at the type level and at runtime.

## 1. Pass a namespace to `compile`

`ns` is the third argument and it is optional. Omit it and the table is keyed by
the bare event names — a single-instance machine passes no dummy string:

```ts
// keys: START, FINISHED, deadline_exceeded
export const solo = compile(watchdog, parts);
// keys: JOB_A.START, JOB_A.FINISHED, deadline_exceeded
const jobA = compile(watchdog, parts, "JOB_A");
```

## 2. Make the namespace a type parameter

`const NS extends string` keeps the literal alive all the way into the emitted
`Transitions` key set, so a factory produces genuinely distinct types per
instance rather than one `string`-keyed table:

```ts
export function region<const NS extends string>(
  ns: NS,
): Transitions<LaneState, LaneMsgIn<NS>, LaneCmd> {
  return compile(lane, { assign, guards }, ns);
}

export const issue42 = region("ISSUE_42");
```

The two msg unions to keep straight:

```ts
/** The BARE msg union — what the parts below are authored against. */
export type LaneMsg = MsgOf<LaneG>;
/** The namespaced msg union — what the compiled machine actually consumes. */
export type LaneMsgIn<NS extends string | undefined = undefined> = MsgIn<LaneG, NS>;
```

Write `assign`, `guards`, `cmds` and `cells` once, against the bare union. The
compiled cell strips the namespace before calling them, so the parts are shared
verbatim by every instance.

## 3. Mark library-minted events `foreign: true`

A machine that consumes a Msg minted by someone else cannot rename it.
`@demlik/tea/deadline` dispatches `{ type: "deadline_exceeded", id, atMs }` from
its own subscribe cell, and no amount of author intent turns that into
`"JOB_A.deadline_exceeded"`. Say whose name it is, in the chart:

```ts
events: {
  START: {
    data: ty<{ readonly jobId: string; readonly deadlineAtMs: number }>(),
    scope: "edges",
  },
  FINISHED: { data: ty<{ readonly at: number }>(), scope: "live" },

  // ── the LIBRARY's event. `@demlik/tea/deadline` owns this name; the shape
  //    below is `DeadlineExceeded` verbatim, and `foreign: true` is what keeps
  //    it bare in the emitted table under every namespace.
  deadline_exceeded: {
    data: ty<{ readonly id: string; readonly atMs: number }>(),
    foreign: true,
    scope: "live",
  },
},
```

A foreign event is a normal event in every other respect. It declares a `scope`,
so every state that scope makes it live in still owes a decision about it —
`idle` above discharges that with `ignore: ["FINISHED", "deadline_exceeded"]`,
and forgetting to is the same unhandled-pair error as any other. Its payload is
typed off the chart's own `data`, so the parts read `m.atMs` rather than an `any`
that leaked in from the Sub.

The one restriction: a foreign name may not contain a dot. A namespaced key *is*
`${ns}.${event}`, so a foreign event literally named `"JOB_A.START"` would be
indistinguishable from instance A's own `START`, and the chart refuses it for
every namespace at once rather than deferring the collision to whichever
`compile` call happens to hit it.

## 4. Check what you got

The key sets say it plainly — two instances share exactly one key, the library's:

```ts
Object.keys((jobWatcher("JOB_A").update as Record<string, object>).working).sort();
// ["JOB_A.FINISHED", "JOB_A.START", "deadline_exceeded"]
Object.keys((jobWatcher("JOB_B").update as Record<string, object>).working).sort();
// ["JOB_B.FINISHED", "JOB_B.START", "deadline_exceeded"]
```

And the guarantee, as types:

```ts
// the author's events are namespaced; the library's is not.
type W2 = Assert<
  Eq<WMsgIn<"JOB_A">["type"], "JOB_A.START" | "JOB_A.FINISHED" | "deadline_exceeded">
>;
// two namespaces still produce genuinely disjoint OWN events — and the overlap
// is EXACTLY the foreign event, because that one really is the same event.
type W3 = Assert<
  Eq<WMsgIn<"JOB_A">["type"] & WMsgIn<"JOB_B">["type"], "deadline_exceeded">
>;
```

Handing instance B a Msg minted for instance A is a compile error, and the
runtime `NoCellError` is the safety net under that refusal rather than a
substitute for it.

## 5. Arm the library's Sub as usual

Nothing about namespacing changes the subscription seam. Declare the Sub from
`subscriptions(state)` and the substrate's reconcile pass arms and disarms it;
the Msg it mints arrives under its bare name at whichever instance armed it:

```ts
export function jobWatcher<const NS extends string>(ns: NS) {
  return defineMachine<WState, WMsgIn<NS>, Cmd<never>, DeadlineSub, Record<never, never>>({
    init: initFrom<WG, WState, Cmd<never>>(watchdog, () => ({ jobId: "", deadlineAtMs: 0 })),
    update: compile(watchdog, parts, ns),
    subscriptions: (s) =>
      s.type === "working" ? [deadlineSub(`deadline:${s.jobId}`, s.deadlineAtMs)] : [],
    subscribe: { deadline: subscribeDeadline },
  });
}
```

Per-event namespacing works identically in the flat reducer form — `compileReducer`
takes the same optional `ns` and applies the same foreign exception.
