# Pattern 06 — The Shape Is Fractal

## The claim

TEA is not a frontend pattern. TEA is **actor model + immutability**, expressed
as a pure function `(state, msg) → (state, effects)`. That function is fractal:
it is the same shape you find in a Redux reducer, an Erlang actor, an XState
statechart, a Cloudflare Durable Object, and an event-sourced aggregate.

The differences between them are not differences of shape. They are differences
of **what the runtime adds around the shape**: an identity (a name + a mailbox),
a persistence boundary (state survives crash), and an integration over time
(the event log replays).

## The isomorphism table

| System | State | Msg | Transition | Effects | Runtime adds |
|--------|-------|-----|-----------|---------|-------------|
| **Elm** | `Model` | `Msg` | `update` | `Cmd` | Virtual DOM, managed effects |
| **Redux** | Store state | Action | Reducer | (missing — middleware fills gap) | Dispatch, subscribe |
| **Erlang actor** | Process state | Message in mailbox | `handle_cast`/`handle_call` | `{noreply, State}` with side effects | Mailbox, supervision, crash recovery |
| **XState** | Context + finite state | Event | Transition + actions | Actions/services | Hierarchy, parallel states, guards |
| **CF Durable Object** | Stored state | `fetch()` request | Alarm/request handler | Outbound fetches | **Identity** (unique name) + **persistence** (crash recovery) |
| **Event-sourced aggregate** | Projected state | Domain event | `apply(state, event)` | Commands to emit | **Time** (event log replays the full history) |

## Why the isomorphism is real, not metaphor

The table above is not an analogy. It is a **mechanical isomorphism**: you can
translate a program written in one column into another column by substituting
the runtime envelope.

A Durable Object's alarm handler IS `update`. Its stored state IS `Model`.
Its outbound fetch IS `Cmd`. The only thing the DO adds that Elm doesn't have
is **identity** (the DO has a unique name and a mailbox) and **persistence**
(state survives process crash).

An event-sourced aggregate's `apply(state, event) → state` IS `update` with
the Cmd half stripped. The event log IS the Msg history. Replaying the log
IS `replay()`.

## The three axes: identity, persistence, time

Strip these from any system in the table and they collapse into the same function:

| Axis | What it adds | Who has it | Who doesn't |
|------|-------------|-----------|-------------|
| **Identity** | A name + a mailbox → "this specific instance" | Actor, DO, aggregate | Reducer, Elm (single-instance) |
| **Persistence** | State survives crash → durability | DO, aggregate, DB-backed actor | In-memory reducer, Elm (refresh = reset) |
| **Time** | Event log → replay full history | Event-sourced aggregate | Everyone else (snapshot only) |

## Where the shape stops applying

Two places. Both are worth naming because they show what TEA *isn't*.

### Streaming / FRP — no discrete Msg

In a continuous signal graph (Cycle.js, RxJS-as-architecture), the transition
function is continuous. There is no discrete `Msg` boundary — data flows as
streams, composed by operators (`map`, `merge`, `switchMap`). You can't
enumerate the message alphabet. You can't assert "when this Msg arrives, this
state results." The audit surface is the operator graph, not the Msg union.

Source: André Staltz, Cycle.js — https://cycle.js.org/

### CRDTs — no central update

In a CRDT (Yjs, Automerge), there is no central `update` function. Convergence
happens via `merge`, not by feeding messages through one reducer. Two replicas
can apply operations concurrently and converge without coordination. The
"transition function" is distributed across peers, not owned by one loop.

## Closing assertion

TEA is not a frontend pattern. **TEA is actor model + immutability**, and that
pattern is **fractal**: the same reducer shape appears at the browser, the Worker,
the Durable Object, the workflow, and the event store. Identity, persistence,
and time are runtime decorations, not shape changes.

The architectural payoff: **one mental model — `(state, msg) → (state, effects)` —
spans the entire stack.** You write a reducer once; you run it in the browser, in a
Worker, in a DO, in a Workflow. The runtime envelope changes; the reducer doesn't.
That is what "fractal" means.
