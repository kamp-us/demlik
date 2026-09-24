# Which update form, and what a missing cell means

Every machine's `update` is a lookup table, and there are two shapes to choose
from. The choice is not a style preference — it decides whether your machine can
say *"in this state, only these messages are valid"*, and whether anything can
ask it that question before dispatching.

## The two forms

**Reducer form** is a flat record keyed by `msg.type`. Every message type gets
exactly one cell, whatever the Model looks like:

```ts
const update: Reducer<Model, Msg, Cmds> = {
  bump: (m, msg) => [{ ...m, n: m.n + msg.by }, []],
  reset: (m) => [{ ...m, n: 0 }, []],
};
```

**Transitions form** is a two-dimensional table keyed by `state.type`, then
`msg.type`. It is available only when your Model is a discriminated union — when
the machine has a phase:

```ts
const update: Transitions<State, Msg, Cmds> = {
  idle: {
    insert_coin: () => [{ type: "brewing", ms: 0 }, []],
  },
  brewing: {
    tick: (s) =>
      s.ms >= 900 ? [{ type: "done", cups: 1 }, []] : [{ ...s, ms: s.ms + 100 }, []],
  },
  done: {
    collect: () => [{ type: "idle" }, []],
  },
};
```

Pick the reducer form when your Model has no phase — a counter, a cache, a
form's field bag. Pick the transitions form when it does, because only the
transitions form can answer which messages a phase accepts.

## A missing cell is a refusal, not an omission

Look at the table above again. Three states, four message types — and four
cells, not twelve. `done` accepts `collect` and nothing else, and it says so by
leaving the other three out.

That absence is a **declaration**. It means: this state does not accept that
message. It is the same thing a statechart means when a state's `on` block does
not list an event, and the same thing XState means when an event has no handler
in the active state.

The alternative is what the reducer form forces, and what this table used to
force before every cell became optional: write the cell anyway and open it with
a guard.

```ts
// The shape a required cell forces. The refusal is now invisible.
collect: (s) => (s.type === "done" ? [{ type: "idle" }, []] : [s, []]),
```

Two things go wrong there. The guard is indistinguishable from a bug — nothing
tells a reader whether that `[s, []]` is a considered refusal or a case someone
forgot to finish. And `acceptedTypes(machine, state)` has to answer *every*
message type for *every* state, truthfully and uselessly, because every cell
exists. A panel deciding which buttons to light, a test asserting a phase's
surface, an agent driver deciding what to dispatch — all three get an answer
that tells them nothing.

## The refusal stays loud

tea diverges from XState on exactly one point here, and it is deliberate
([ADR 0011](../../../../.decisions/0011-errors-as-data.md)). An unhandled message is
not silently ignored. Dispatching it raises `NoCellError`, and the error carries
the accepted set:

```ts
acceptedTypes(machine, { type: "done", cups: 1 }); // ["collect"]

applyCell(machine, { type: "done", cups: 1 }, { type: "tick" });
// NoCellError: no cell for msg "tick" in state "done".
//              This state accepts: "collect"

// The same refusal as a value, for a caller that wants to branch on it:
const r = tryApplyCell(machine, { type: "done", cups: 1 }, { type: "tick" });
r._tag === "Err" && r.error.acceptedTypes; // ["collect"]
```

`acceptedTypes` and the error's own `acceptedTypes` are one reading, not two
that happen to agree — the refusal path calls the same helper. Asking first and
dispatching-and-catching can never be told different things about the same
machine and state.

On a running machine the refusal rejects that one dispatch and nothing else. A
missing cell is not a reducer throw: no machine code ran, the caller sent a
Msg this state does not take. So `supervision` stays out of it under every
strategy. The run does not halt, `restart` does not rehydrate, and `onError`
hears nothing under `"reduce"`. The refused Msg never reaches the store or
`observe`, so a replay of the run never meets it. The next Msg the state does
accept is applied as usual. A host that forwards Msgs from outside (a UI, a
socket, an agent) can catch the `NoCellError` and carry on.

## A row is required; a cell is not

The asymmetry is the whole design. Leaving a **cell** out is a statement about
one message. Leaving a **row** out would be a statement about a whole phase you
may simply have forgotten to write, so it does not compile: adding a member to
your State union obliges you to say what that phase does. A phase that accepts
nothing at all writes the empty row, and means it:

```ts
const update: Transitions<State, Msg, Cmds> = {
  // …
  expired: {}, // terminal: this phase takes no message
};
```

## Getting the old floor back, per machine

Some tables genuinely want the compiler to force a decision on every
`(state, message)` pair — a protocol where every pair is meaningful, or a table
under review. Annotate it with `ExhaustiveTransitions` instead:

```ts
const update: ExhaustiveTransitions<State, Msg, Cmds> = {
  idle: { insert_coin: …, brew: …, tick: …, collect: … },
  brewing: { insert_coin: …, brew: …, tick: …, collect: … },
  done: { insert_coin: …, brew: …, tick: …, collect: … },
};
```

It is the same table type with every cell required, so `defineMachine` takes it
unchanged — this is an annotation you put on your own table, not a third form.
You pay for it in the coin above: every refusal has to be spelled as a cell, and
every state then reports every message type from `acceptedTypes`. That is why it
is opt-in.

## What the settled messages do

A machine that declares `cmds` gets a `<name>_ok` / `<name>_err` message pair per
command, folded into `Msg` without your spelling them. Those are ordinary
messages here: handle them in the one state that is waiting for that command,
and leave them out everywhere else. A late `fetch_ok` arriving after the machine
has moved on is refused by the state it lands in, loudly, with the accepted set
attached — rather than absorbed by a cell that had to exist.

## Further reading

- [Why failures are values and bugs are throws](./errors-as-data.md) — why
  `NoCellError` is a throw and not a tagged value in Model.
- [Build your first machine](../tutorial/build-your-first-machine.md) — the
  reducer form, end to end.
