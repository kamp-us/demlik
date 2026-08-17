# Reconcile the actual world against a desired spec

To converge a fleet, a table, or an audit surface on a spec you declare, hand
`@demlik/tea/reconciler` a config describing how to WALK the actual world and how
to DIFF it, and it runs the scan → plan → apply loop for you: the scan is a
`paginated-walk` slice (so it inherits retry, circuit, rate-limit and deadline),
and each applied change lands in a `cache`-backed ledger so a resumed reconcile
never re-applies what already settled.

## 1. Describe the reconcile in one config

`desired` is whatever spec your domain speaks; `diff` turns it plus the scanned
actual snapshot into an ordered `Change[]`; `apply` maps one change to the Cmd
that realizes it. The scan knobs (`firstPage` / `nextCursor` / `itemsOf`) say how
the actual listing is paged, and the resilience bricks are the same optional
knobs `paginated-walk` exposes:

```ts
import { type Cmd } from "@demlik/tea";
import { createReconciler } from "@demlik/tea/reconciler";

interface Node { readonly id: string; readonly version: number }
interface Page { readonly offset: number; readonly nodes: readonly Node[]; readonly last: boolean }
interface Desired { readonly version: number; readonly ids: readonly string[] }
interface Change { readonly nodeId: string; readonly to: number }
type ApplyCmd = Cmd<"apply_change"> & { readonly change: Change };

const rec = createReconciler<Node, Desired, Page, Change, ApplyCmd, number>({
  desired: { version: 2, ids: ["a", "b", "c"] },
  diff: (d, actual) => {
    const byId = new Map(actual.map((n) => [n.id, n.version] as const));
    return d.ids
      .filter((id) => (byId.get(id) ?? 0) < d.version)
      .map((id) => ({ nodeId: id, to: d.version }));
  },
  apply: (change) => ({ type: "apply_change", change }),
  idOf: (change) => change.nodeId,
  firstPage: 0,
  nextCursor: (p) => (p.last ? null : p.offset + 1),
  itemsOf: (p) => p.nodes,
  retry: { baseMs: 100, factor: 2, capMs: 10_000, maxAttempts: 3, jitter: "full" },
  rateLimit: { capacity: 5, refillPerSec: 1 },
  deadline: { ms: 5_000 },
});
```

`idOf` keys the applied ledger. Give it a domain id when one exists; omitting it
falls back to the change's serialized content. Never key by plan position — the
ledger has to survive a re-plan.

## 2. Hold the slice in your Model

```ts
import type { ReconcilerState } from "@demlik/tea/reconciler";

interface State {
  readonly rec: ReconcilerState<Node, Change, Page>;
}

// inside init:
init: (loaded) => (loaded !== null ? [loaded, []] : [{ rec: rec.init() }, []]),
```

The slice is flat plain data — the walk cursor, the accumulated `actual`, the
`plan`, the `appliedCursor`, the ledger — so it round-trips through JSON and a
reconcile evicted mid-scan or mid-apply resumes from the exact position.

## 3. Wire the verbs into `update`

Five cells cover the whole lifecycle. `liftReconciler` splices the knob result
back into a Model whose field is named `rec`:

```ts
import { liftReconciler } from "@demlik/tea/reconciler";

// inside update:
reconcile:      (s, m) => liftReconciler(s, rec.scan(s.rec, m.at)),
resilient_ok:   (s, m) => liftReconciler(s, rec.pageOk(s.rec, m.result, m.at)),
resilient_err:  (s, m) => liftReconciler(s, rec.pageErr(s.rec, m.error, m.at)),
change_done:    (s, m) => liftReconciler(s, rec.applied(s.rec, m.change, m.at)),
deadline_exceeded: (s, m) => liftReconciler(s, rec.onTimer(s.rec, m)),
```

`resilient_ok` / `resilient_err` are the inherited page-settle Msgs, typed as
`ScanPageOkMsg<Page>` / `ScanPageErrMsg`; `deadline_exceeded` is
`ReconcilerTimerMsg`. Time is always the Msg's `at` — no verb reads a clock.

The hand-off is automatic: when a page arrives whose `nextCursor` is `null`, the
scan is exhausted, `pageOk` runs `diff` against the full actual snapshot, enters
`applying`, and emits the FIRST apply Cmd. Each `change_done` writes that change
into the ledger and emits exactly the next one, so the actual world is mutated
one change at a time. An already-in-sync world yields an empty plan and settles
`done` with no Cmds at all.

## 4. Interpret both sides of the loop

The scan's page fetch is pre-wired — `handlers(ports)` wraps your `run(cursor)`
in the inherited Railway interpret, so a throwing listing call becomes the
`resilient_err` your `pageErr` cell already handles. The apply Cmd is yours,
because only you know how to realize a change:

```ts
interpret: {
  ...rec.handlers({ run: (cursor) => api.listNodes(cursor) }),
  apply_change: async (cmd) => {
    await api.upgrade(cmd.change.nodeId, cmd.change.to);
    return { type: "change_done", change: cmd.change, at: Date.now() };
  },
},
```

Echo the change back on the settle Msg: `applied` recomputes its ledger key from
the change's own identity, which is what keeps the skip check correct across a
re-plan.

## 5. Let the scan's timers reconcile themselves

`subs` is exactly the walk's sub set — a retry timer while a page is
`waiting_retry`, a per-page deadline timer while a fetch is in flight — and it
empties once the scan finishes, because the apply loop has no timers of its own:

```ts
import { subscribeDeadline } from "@demlik/tea/reconciler";

subscriptions: (s) => rec.subs(s.rec),
subscribe: { deadline: subscribeDeadline },
```

A transient page failure backs off with the scan cursor parked, and the retry
timer re-issues the SAME page. When the page-fetch retries are exhausted the
whole reconcile escalates to `failed` — an incomplete actual snapshot is never
diffed.

## 6. Resume and re-plan without double-applying

After an eviction you reload the slice and drive the loop again; `applyNext`
walks the plan from the cursor, skips every change whose id is already in the
ledger, and parks on the first one that is not:

```ts
// inside update — resume the apply loop after a boot from the store:
resume: (s, m) => liftReconciler(s, rec.applyNext(s.rec, m.at)),
```

The same verb pair handles a spec change. `planned(state, at, changes)` installs
a plan directly (skipping the diff); call it with no `changes` to re-diff the
slice's accumulated `actual` against `config.desired`. Because the ledger is
keyed by change identity rather than slot, a brand-new change that happens to
land at an already-applied index is still applied.

That is the whole loop: `rec.isComplete(state)` is true once every planned change
has settled, and a `failed` phase carries the terminal scan error inside the walk
slice as plain data. For the scan half on its own — paging a listing with the
same resilience but no diff — reach for `@demlik/tea/paginated-walk`; for the
ledger primitive, `@demlik/tea/cache`; and see "Add retry and backoff to a call"
for the policy knobs `retry` accepts.
