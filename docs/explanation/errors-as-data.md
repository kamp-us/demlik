# Why failures are values and bugs are throws

`@demlik/tea` splits everything that can go wrong into two kinds, and gives each
kind a different shape. A **recoverable failure** — the network said no, the
token expired, the deadline lapsed — is a plain tagged value folded into your
Model. A **contract breach** — two ports registered under one name, a reducer
with no cell for a Msg — is a thrown `Error`.

The rule that decides which one you are holding is a single question: **does the
caller have a next move?**

## The question, applied

| The failure | Next move | Shape |
|---|---|---|
| A call's deadline lapsed | retry, or give up on this item | `{ _tag: "deadline_exceeded", … }` in Model |
| A call came back 401 | send the user to log in again | `{ _tag: "unauthorized", … }` in Model |
| Two ports share a name | none — the wiring is wrong | `throw new PortNameCollisionError(…)` |
| A reducer has no cell for a Msg | none — the machine is incomplete | `throw new NoCellError(…)` |

The first two are outcomes of a program that is working correctly; the world
just said no. The last two mean the code itself is wrong, and no handler
anywhere can do anything useful with them.

## Why a recoverable failure cannot be an `Error` object

This is not a style preference. It falls out of the one property the whole
library is built on: **your Model is plain JSON**. It is folded from messages,
saved through a `Store`, and reloaded after the host that was running it went
away. Anything that becomes part of Model has to survive that round trip.

A `class extends Error` does not. Save it, reload it, and you get `{}` — the
prototype is gone, so `instanceof` no longer matches, and the `_tag` you were
going to switch on is gone with it. Your error-handling branch silently stops
firing after a restart, which is the worst possible time for it to stop.

A plain `{ _tag: "unauthorized", status: 401 }` reloads as exactly itself. That
is the entire reason for the shape: it is the only one that still means
something on the other side of persistence.

```ts
// After a reload, this branch still works — the tag is data.
switch (state.lastCall._tag) {
  case "unauthorized":
    return [{ ...state, phase: "reauth" }, [login()]];
  case "deadline_exceeded":
    return [{ ...state, attempts: state.attempts + 1 }, [retry()]];
}
```

Switch on `_tag`. Do not reach for `instanceof` on a value that came out of
Model — only the tag survives.

## Where the two kinds show up in the types

The split is not only a convention you follow by hand — it is the two channels of
[`Cmd<T, E, R>`](../reference/tea.md), the effect type every command in the
library is defined as. `T` is what the effect settles with when it works, `E` the
tagged failures it may settle with instead, and `R` the ctx it reads. A tool
declares both channels in the same shape: its `ok` schema is `T`, its `err` tag
list is `E`. See [Declare a
tool](../tutorial/build-a-durable-agent.md#declare-a-tool) for that read on a
real tool.

A contract breach appears in neither channel. There is no `E` arm for "the wiring
is wrong", because the whole point of `E` is that the caller has a next move —
which is the same question this page opened with, now asked by the compiler.

## Why bugs are not also data

Consistency would say: make everything a value. The problem is that a bug has no
handler. Hand `{ _tag: "port_collision" }` up the stack as a value and one of two
things happens. Either nobody handles it, it reaches the top, and it gets thrown
there anyway — so the throw only moved, and every call in between paid for the
plumbing. Or somebody quietly swallows it and the program keeps running on
corrupted state, which is strictly worse than stopping.

Stopping loudly at the fault is the correct behaviour for a bug. You get a real
stack trace pointing at the line that is wrong, and the test goes red where the
mistake is rather than three layers away.

## Most bugs never reach a throw

The throws are a backstop, not the first line. The type system refuses the
common mistakes at compile time: a reducer that returns a Promise does not
type-check, and an exhaustive cell map turns a missing case into a compile error.
The runtime throws catch what types cannot — a value that arrived untyped from
the wire, or a cast that lied. Compile-time refusal first; the throw is the net
under it.

## What this means for your code

- **Handle recoverable failures in the reducer**, by switching on `_tag`. They
  are ordinary data and belong in the fold like any other message.
- **Do not catch a thrown TEA error to keep going.** It is telling you the
  program is wrong. Let it stop, read the stack, fix the wiring.
- **Never put an `Error` object into your own Model.** It will reload as `{}`.
  If you are wrapping a failure from your own code, give it a `_tag` and keep it
  JSON.
- **Do not throw your own recoverable failures out of a handler** if the machine
  is supposed to react to them. Settle them as values so the reducer can see
  them.

## Further reading

- [Make a machine durable and crash-recoverable](../how-to/make-durable.md) — why
  Model has to be JSON in the first place.
- [ADR 0011 — Errors are data; a throw is reserved for a contract breach](../../.decisions/0011-errors-as-data.md)
  — the decision record, written for maintainers of the library.
