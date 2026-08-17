# Why charts keep their types

A machine authored as data is worth having: one value that the State union, the
Msg union, the Cmd union, the `update` table and the diagram are all derived
from, so none of them can drift from the others. The usual price is narrowing.
`@demlik/tea/chart` does not pay it, and this page explains the mechanism that
gets out of it — and what it still costs.

## The hole config-authored machines normally fall into

Write a state machine as a config object and the transitions become strings. An
edge says `when: "retriesRemaining"`; the guard itself lives somewhere else, in a
bag of functions keyed by that name. TypeScript types things at their
*declaration* and checks them at their *use*, and here the declaration — the
function in the bag — has no idea which use it belongs to. So the best a config
library can do is type every guard against the whole context and the whole event
union: `(ctx: Ctx, event: AnyEvent) => boolean`. XState v5 landed exactly there,
and says so (statelyai/xstate#4686): actions and guards referenced by string
receive the full event union, and narrowing inside them is the author's problem,
usually solved with a cast or an `as` on the event.

That is not a small tax. It is the tax on the thing the config form is for. The
whole reason to write `review: { on: { FAIL: { when: "retriesRemaining" } } }` is
that the chart knows FAIL arrives at `review` — and then the guard is handed a
message that could be any of twelve.

## Reverse the arrow: type the function from its use sites

The fix is to stop typing the bag as a standalone declaration and start deriving
it from the graph. The chart is a `const`-inferred literal, so every edge, every
target and every string reference survives as a literal type. That makes the
graph *scannable*: given a guard name, the type layer can go find the edges that
reference it.

`GuardName<C>` is not declared anywhere — it is the union of every `when` value
appearing on any edge, so a guard's name is written once, as a reference, and
never as a declaration. `SitesWhere<C, "when", N>` then scans state × event for
the edges whose `when` is `N` and yields their keys, `"review.FAIL"`. And
`SiteArgs` turns each key into the parameter list for that site:

```ts
type SiteArgs<K, S, M> = K extends `${infer From}.${infer Ev}`
  ? [state: Narrow<S, From>, msg: Narrow<M, Ev>, at: K]
  : never;

export type Guards<C, S extends { type: string }, M extends { type: string }> = {
  [N in GuardName<C>]: (...args: SiteArgs<SitesWhere<C, "when", N>, S, M>) => boolean;
};
```

For `retriesRemaining`, used at one edge, that resolves to `(state: ReviewState,
msg: FailMsg, at: "review.FAIL") => boolean`. The guard body reads `s.retries`
and `m.reason` with no cast, and reading a field that is not on the `review`
state or not on the `FAIL` message is an error (`e3-guard-bad-field.ts`). The
narrowing is not recovered by the author; it never left.

## The `at` parameter, and why it has to exist

Now use one guard from two edges. `SiteArgs` distributes, so the parameters
become a *union of tuples*: `[FetchingState, TimeoutMsg, "fetching.TIMEOUT"] |
[ParsingState, CorruptMsg, "parsing.CORRUPT"]`. A union of tuples is honest, but
on its own it is not usable — the body needs some way to say "this call is the
first site", and narrowing `state.type` does not do it.

That is not a quirk of this library. TypeScript re-narrows sibling parameters
from a discriminated tuple union (TS 4.6, microsoft/TypeScript#47109) only when
the discriminant is a *direct, literal-typed element* of the union. `s.type` is
a nested discriminant: testing it narrows `s` and leaves `m` the full union.
`e8-multisite-guard-undiscriminated.ts` pins that down — a body that never
discriminates sees both parameters as the whole union and every site-specific
field is rejected.

So the site tag is passed as a real third parameter. It is a direct element, its
type is a literal per member, and one `switch (at)` collapses the tuple union:
`state` and `msg` narrow *together*.

```ts
export const rGuards: Guards<RG, RState, RMsg> = {
  worthRetrying: (s, m, at) =>
    at === "fetching.TIMEOUT"
      ? s.attempt < 3 && s.url !== "" && m.afterMs < 30_000
      : s.attempt < 5 && s.bytes > 0 && m.offset >= 0,
};
```

Every field above exists at exactly one site. Read `m.offset` in the TIMEOUT
branch and it is rejected against that one narrowed member, not against the whole
union (`e7-multisite-guard-bad-field.ts`). For a single-site name the union has
one member, so the tuple is not a union at all and the author may keep writing
`(s, m) => …` and ignore the tag entirely.

The compiled walk passes the same tag it computes the table with — the site the
type layer correlates on *is* the site the runtime dispatches from
(`smoke-multisite.ts` exercises both edges to prove it).

Cmd builders and cells use the same two types. `Cmds` is `SitesWhere<C, "cmd",
N>`; `Cells` is `SitesWhere<C, "cell", N>`. That is deliberate: the escape hatch
did not get its own narrowing mechanism, which is why a multi-site cell body
behaves exactly like a multi-site guard body, down to the diagnostics
(`e25-multisite-cell-bad-field.ts`).

## What totality buys

Narrowing makes the parts honest. Totality makes the *chart* honest: every
(state, event) pair is either declared as an edge or explicitly refused, and a
third case does not compile.

The naive version of that obligation costs |S| × |M| author-written strings — 30
states by 12 events is 300 hand-typed refusals, which authors produce by pasting
the compiler error back, which is the same as not deciding. So the decision is
*quantified* instead of enumerated: each event declares once, as its `scope`,
where it means anything. `"edges"` means live only where routed; a phase name
means broadcast within that phase; `"all"` means machine-wide. `MissingAt<C, S>`
is then the live events at `S` minus the handled ones minus the ignored ones, and
`Total<C>` demands a property whose *name is the sentence*:

```
unhandled pair "verifying.cancel" — declare it in `on`, or list "cancel" in
this state's `ignore`, or narrow the `scope` of event "cancel"
```

The diagnostic is the property name because tsc prints a missing property
verbatim, and its value is `never` so it cannot be silenced by writing the key.
`e13-unhandled-pair.ts` is the regression that keeps it.

What that buys is a specific kind of safety: adding a state to a phase re-asks
every question that phase's events pose, at the new state, by name. You never
wrote the pair down; you said once that `cancel` means something throughout
`live`.

Totality is also defended from its own degenerate forms. An `ignore` entry naming
an event that is not live where it sits refuses nothing, and is rejected
(`e17-refusal-refuses-nothing.ts`) — otherwise refusals decay into pasted-back
noise and stop meaning anything. A `scope` naming a phase that does not exist is
a name error, not a silently empty obligation (`e18-scope-typo.ts`), because the
phase universe is `keyof states` and phases are declared by *being* keys. A state
declared under two phases makes "which phase is this in?" ambiguous and every
scope decision apply twice, so it is unrepresentable (`e16-state-in-two-phases.ts`).
And `end: true` means "accepts nothing", so it cannot also accept something
(`e14-end-state-with-edge.ts`).

## Assignability is not enough — the strictness layer

One subtlety worth knowing, because it explains a whole class of checks that
would otherwise look like belt-and-braces. Constraint checking is plain
assignability, and assignability does *not* run excess-property checks. So
`{ target, whn, otherwise }` structurally satisfies `{ target: SN; cmd?: … }`,
and a typo'd `when` would compile with the guard silently dropped
(`e6-stray-edge-field.ts`). Likewise a typo'd event key in `on` would invent an
edge for an event that does not exist (`e5-undeclared-event.ts`).

The `Strict<C>` F-bound closes it by mapping an offending shape to a marker
object naming the offender, which the object-literal check then rejects. The
markers read as sentences too — `__cellEdgeCannotAlsoDeclare`,
`__toWithoutACellToPickFromIt`, `__otherwiseCmdWithoutAGuard`.

Underneath that layer sit the ordinary reference checks, which are ordinary only
because the chart owns every alphabet. A target naming a state that does not
exist is a name error with tsc's "Did you mean …?" against the real names
(`e1-typo-target.ts`); so is an `ignore` entry (`e15-ignore-typo.ts`), an
`assign` key naming a pair with no edge (`e19-assign-key-typo.ts`), and an edge
firing a Cmd the `cmds` section never declared (`e11-unknown-cmd-name.ts`).
`otherwiseCmd` on an unguarded edge has no arm to fire from and would sit in the
chart looking load-bearing (`e12-else-cmd-no-guard.ts`).

The parts bags carry the mirror-image obligation. `Assigns` is total over the
declared edges, so a missing builder is reported by name
(`e2-missing-assign.ts`), and one returning the wrong shape for its target is
rejected against that target's payload alone (`e4-wrong-payload.ts`). `Parts`
makes `cmds` required the moment the chart names one
(`e9-missing-cmd-builder.ts`), and each builder owes exactly the payload the
`cmds` section declared for that name, not whatever it happens to return
(`e10-wrong-cmd-payload.ts`).

## The escape hatch, and why the chart stays truthful

Some transitions genuinely cannot be declared. `resilient-fetch`'s `attempt()`
chains a cache, a circuit breaker, a rate limiter and a retry ladder, and lands
on one of five states by rules that are those modules' business, not the chart's.
A single binary `when` names two targets; this needs five.

`{ to: [...], cell: "attempt" }` splits the fact in two. The chart declares the
*set* of reachable targets — which is what the diagram draws and what the cell's
return type is clamped to — and code decides only which of them, this time. A
cell returning a state outside its edge's `to` is rejected with the offending
literal named (`e23-cell-target-outside-to.ts`). That clamp is the entire bargain:
without it the hatch would be a hole in the drawing, and the drawing is the
product.

The surrounding checks keep the hatch from being two ways of saying one thing. A
cell edge may not also carry `cmd`, `when`, `otherwise`, `target` or `resume` —
each would be a second, silently ignored source of a decision the cell already
makes (`e24-cell-with-illegal-sibling.ts`). `to` with no `cell` is a fan-out
nobody chooses among (`e27-to-without-a-cell.ts`). And an `assign` entry for a
cell edge is not merely optional but not a key of the bag at all, so writing it
is an excess property tsc names (`e26-assign-for-a-cell-edge.ts`).

## Namespacing, and the events that are not yours

The same literal-preservation that makes the graph scannable makes N instances of
one chart safely disjoint. `compile(chart, parts, ns)` keys the author's own
events `${ns}.${event}` while the parts stay written against the bare union, so
instance A's `START` is not a key of instance B's table — a compile error, with
the runtime `NoCellError` as the net beneath it (`e22-cross-instance-msg.ts`).

The exception is an event the author does not own. A Msg minted by
`@demlik/tea/deadline` arrives as `deadline_exceeded` no matter whose instance
armed the timer, so `foreign: true` keeps it bare under every namespace — which
also makes it the one key two instances share, correctly, because it is the same
event. Since a namespaced key *is* `${ns}.${event}`, a foreign name containing a
dot would be indistinguishable from a namespaced one, and is banned for every
namespace at once rather than caught per-`compile`
(`e20-foreign-name-collides-with-namespace.ts`). Nothing else about a foreign
event changes: it declares a `scope`, and every state that scope makes it live in
still owes a decision (`e21-unhandled-foreign-pair.ts`).

## The flat form, and what it honestly gives up

Many real machines have no phase dimension. Their logic is keyed by the message;
`state.type` is a label the handler writes rather than a dimension it dispatches
on. `resilient-fetch` is one: four cells, six states, and only one of the four
asks which state it is in — inside its own body. Forcing it into a grid restates
each of those four facts six times, which is 18 edge declarations manufacturing
knowledge the machine does not have.

`defineReducerChart` drops the dimension. `on` moves to the top level, `states`
becomes a flat name list, and `scope` disappears because "at which states does
this event mean anything?" has no content when there is one. Totality is not
dropped, only re-quantified: `on` is a *required* mapped type over the event
alphabet, so a declared event with no edge is a missing property tsc names
(`e29-reducer-unhandled-event.ts`) — and per-event that is *stronger* than the
grid form, where `scope: "edges"` permits an event routed from nowhere at all.
Every other mechanism is reused verbatim: the same `EdgeSpec`, the same `to`
clamp (`e31-reducer-cell-outside-to.ts`), the same `at` correlator, the same
per-event namespacing, the same strictness layer
(`e30-reducer-undeclared-event.ts`, `e32-reducer-initial-not-a-state.ts`,
`e33-reducer-assign-for-a-cell-event.ts`).

What it genuinely loses is the per-state refusal. A grid chart can say "in `done`,
`poll_failed` is dropped" and draw it; a reducer chart cannot, and that decision
goes back into the cell body where the hand-written original had it. That is a
real reduction in what the drawing knows, and the honest reading is that the grid
form did not *recover* that knowledge from such a machine — it manufactured it.
`resume` is refused here for the same reason (`e28-reducer-resume-edge.ts`): `was`
is derived from the states with an edge into the parking state, and with every
edge reachable from everywhere the derivation degenerates to "all of them".

## The limits, stated plainly

- **A multi-site cell's return type clamps to the union across its sites.** The
  parameters stay exact per site; the return does not. A cell used at `a.X`
  (`to: ["a","b"]`) and `b.Y` (`to: ["a","c"]`) has return type `a | b | c` in
  both branches. Two cells cost one extra name and restore the precision.
- **`to` is only as precise as the delegate's declared return type.** The clamp
  checks what the cell returns. A cell that forwards a helper annotated as the
  whole State union hands the chart nothing to narrow.
- **The two forms are two functions.** A chart cannot be flipped between grid and
  flat with a flag; it is an edit to `states`, `on` and every `scope`.
- **Subscriptions stay hand-written, deliberately.** A `Sub` reconciles on its
  id, and the id is a projection of the state's *data* — the one thing the graph
  does not and should not know. A config could at best say "sub type `ws` is live
  in states X and Y", and the author would still hand-write the id builder, now
  split across two files with the reconcile semantics hidden behind a declaration
  that no longer shows them.

## Where the guarantees live

Every claim above is pinned by an executable file rather than by this page.
`src/chart/assert.ts` holds the type-level assertions `A1`..`A80` — the derived
alphabets, the exact parameter tuples of a two-site guard, the cell's clamped
return, the emitted key sets. `src/chart/smoke*.ts` runs the compiled machines.
And `src/chart/__probes__/e*.ts` is one file per compile-time error the design
catches, each with a header explaining what would have gone silently wrong
without it. If a claim here and a probe there disagree, the probe is right.
