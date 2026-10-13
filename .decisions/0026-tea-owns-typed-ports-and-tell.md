---
id: 0026
title: "tea owns typed ports on a machine and a `tell` that never waits, never the program, the route graph or the registry"
status: accepted
date: 2026-10-13
tags: [tea, ports, tell, tuval, export-map]
---

# 0026 — tea owns typed ports on a machine and a `tell` that never waits, never the program, the route graph or the registry

**What this decides:** a tea machine can declare typed in and out ports and hand a Msg to another
running machine with `tell`; everything that finds, routes or lists machines stays in the host.

## Context

Tuval wrote its own "program" on top of tea: a machine plus named, typed ports, a check that two
ports fit, a route graph, a registry and `defineProgram`.
[#635](https://github.com/kamp-us/demlik/issues/635) asked how much of that tea should own, and
left three answers open: none, a typed boundary on `Cmd.define`, or the Tuval model.

tea already had a thing called a port. `definePort` is a named outgoing channel with no shape, and
nothing outside tea's own source and tests uses it. So "port" meant two things.

Earlier rulings pull against tea taking any of this: round R1.1 of
[#325](https://github.com/kamp-us/demlik/issues/325#issuecomment-5808832579) (tea does not grow to
fit a host), "no registry" from [#312](https://github.com/kamp-us/demlik/issues/312) and
[#554](https://github.com/kamp-us/demlik/issues/554),
[ADR 0020](./0020-tea-owns-no-dependency-injection.md) and
[ADR 0022](./0022-no-battery-layer-plain-functions.md).

The founder ruled on it in
[this comment](https://github.com/kamp-us/demlik/issues/635#issuecomment-6139737462), after the
grilling session [#637](https://github.com/kamp-us/demlik/issues/637). This record writes that
ruling down. The reason it gives for the shape of out ports and `tell` is Effect's: every send has a
typed success and a typed failure, so both are always thought about.

## Decision

**tea owns port declarations on a machine and a `tell` that never waits. It does not own
`defineProgram`, the route graph or the registry.**

This is answer 3 of the issue in part. Two things are added that none of the three answers named:
an out port always reports back, and `tell`.

### What tea owns

1. **Ports on `defineMachine`.** `ports: { answer: port.in(...), brief: port.out(...) }`. The field
   is opt-in. A port takes a shape and a required description; a blank description is refused. An
   in port also takes a required limit. The machine's listing gives each port's name, direction,
   description, limit, and the JSON Schema when the shape carries one. tea's core makes no JSON
   Schema itself.
2. **A shape only checks. It never translates.** A schema whose two sides differ, a brand included,
   is refused when the code is compiled. tea hands on the value as it arrived, never the check's
   output. The compiler catches a difference in type. A change that keeps the type passes the
   compiler and is not applied. A program that wants a transformation does it itself. Core
   `Cmd.define` keeps taking any Standard Schema, so a port is stricter than a Cmd.
3. **In port.** A value that arrives is an ordinary Msg named after the port, with a `payload`
   field.
   - Its shape is checked before the Msg joins the machine's line, and only there. Replay does not
     check, so tightening a shape never makes an old log refuse to replay.
   - The same check covers a plain outside `dispatch`, as a new typed failure on `dispatch`. From a
     Sub, a bad shape goes to the error sink.
   - A declared in port has a cell in every state.
   - A check that throws or does not finish synchronously is a refusal. It is never silence and
     never a crash.
4. **Out port.** An out is a value returned from `update`. It always reports back.
   - Both the `<port>_ok` and the `<port>_err` cell are required. A machine with a declared out
     port and a missing cell is refused when it is defined.
   - tea checks the payload against the out port's own shape before the handler runs. A payload
     that does not fit becomes `_err` tagged `malformed_payload`, and the handler does not run. A
     check that throws or does not finish synchronously counts as a payload that does not fit.
   - This check is for out ports only, not for every `Cmd.define`d Cmd.
5. **`tell`, one helper, and it never waits.** It puts a Msg on another running machine's line and
   answers one word at once: `queued`, `sent`, `full`, `stopped`, `bad_shape` or `no_cell`.
   - `queued` is said only for a declared in port. Any other Msg gets `sent`.
   - tea fixes what the two outcomes carry. `_ok` carries `queued` or `sent`. `_err` carries one of
     the four refusals, or one of tea's own two tags, `malformed_payload` and `malformed_result`.
   - No host code decides which word counts as a success. A handler returns what `tell` answered.
   - One out, one answer. A host that sends one out to several receivers folds them as "all taken,
     or the first refusal".
   - The same helper hands a child's output to its parent.
   - `tell` takes the target run as an argument.
   - The waiting `tell` built in [#556](https://github.com/kamp-us/demlik/issues/556) is replaced by
     this one. `spawn` and `stop` do not change.
   - An out port is for handing a value to another machine. Its handler may also hand the value to
     host code that cannot refuse, such as a record of the last value, and answer `sent`. A call
     that can fail in its own ways is a `Cmd.define`d Cmd and keeps its own failure words.
6. **Ask-and-answer.** Open asks live in the machine's State. A machine that writes its answer cell
   with tea's helper must write both branches: the answer matched an open ask, or it matched none.
   tea forces the branch to exist, not what it does.
7. **Fit is shape only, and exact.** More fields does not fit. Descriptions, titles and examples
   never change fit. Fit reads no version. A shape that carries no JSON Schema answers "cannot
   tell".
8. **The old port family goes.** `definePort`, `fromPort`, `ctx.emit`, `subscribePort`, `emitPort`,
   `Port` and `PortEmitter` are removed before or with the new `port`, never after. "Port" means one
   thing in every published version of tea. `fromPort` gets no replacement. This is a breaking
   change on the stable `.` entry, shipped as a minor with a callout
   ([ADR 0016](./0016-removal-lands-in-a-minor-at-0x.md)), and it changes the ctx type of every
   handler.

### What stays in the host

The registry, the table of running machines, the route graph, wiring from config, finding a machine
by name, the desk, `Program.shape`, the last value of a port, a default limit (a host's own `port`
may fill one in), and every full-line rule other than refusing: wait-for-room, and throwing away the
oldest or the newest.

### Where the code lives

No new package and no new export entry.

| What | Entry |
|---|---|
| `port`, for any Standard Schema | `.` |
| `port`, for plain Effect schemas | `@demlik/tea/effect`, next to its own `Cmd` from [#631](https://github.com/kamp-us/demlik/issues/631) |
| `tell`, Promise engine | `@demlik/tea/promise` |
| `tell`, Effect engine | `@demlik/tea/effect`, where it is today |
| `spawn`, `stop` | `@demlik/tea/effect`, unchanged |

The ruling says `tell` ships for both engines in the existing entries and leaves this record to
name them. Each engine has one entry, so the Promise `tell` goes to `@demlik/tea/promise`. That
widens where `tell` lives.

The `effect` import rule in [`MAINTAINING.md`](../packages/tea/MAINTAINING.md) is unchanged. The
core `port` in `.` imports no engine and no `effect`. Only the `port` and `tell` in
`@demlik/tea/effect` import `effect`.

### The earlier rulings

| Ruling | Result |
|---|---|
| [#325](https://github.com/kamp-us/demlik/issues/325#issuecomment-5808832579) round R1.1 | **Narrows.** tea still does not grow to fit a host. The test moves from "can a host do it with tea plus Effect" to "can a host do it correctly itself". Two things a host cannot: a port's declaration, listing and check have one source only when they sit on the machine, and a hand-over that does not wait needs the run's own line. |
| "No registry" ([#312](https://github.com/kamp-us/demlik/issues/312), [#554](https://github.com/kamp-us/demlik/issues/554)) | **Stands.** tea keeps no table of runs and finds nothing by name. |
| [#554](https://github.com/kamp-us/demlik/issues/554) | **Stands.** tea ships the helpers. The `tell` built in #556 changes as in item 5. |
| [ADR 0020](./0020-tea-owns-no-dependency-injection.md) | **Stands.** A port adds no provider, no registry of services and no requirements parameter. |
| [ADR 0022](./0022-no-battery-layer-plain-functions.md) | **Stands.** A `ports` field and a plain `tell` mount, wrap and compose nothing. |

Also standing, and leaned on: [ADR 0016](./0016-removal-lands-in-a-minor-at-0x.md) (removal in a
minor), [ADR 0018](./0018-tool-overlap-inside-the-cmd-handler.md) (one handler at a time) and item 5
of [ADR 0021](./0021-handler-outcome-becomes-the-msg.md).

### Deliberate changes against Tuval and Elm

- An out port is never one-way. It always reports back.
- A full line refuses (`full`) where Tuval's default makes the sender wait. `tell` never waits.
- A description and a limit are required on the declaration.
- Fit ignores descriptions. Tuval compares them today.
- The check on the way out refuses on every path. Tuval's routed path does not.
- Against Elm: a bad incoming value is not handed to the program as data. It is refused on the way
  in.

### What gets built

Nothing is built with this record. The record is the whole of this change.

The build is one epic, [#657](https://github.com/kamp-us/demlik/issues/657), in this order, each
step with its guard:

| Step | Items above | Where it lands |
|---|---|---|
| 1. The port itself | 1 without the limit, 2, 3, 8, and the fixed outcome shapes of 5 | #657 |
| 2. Both outcomes forced | 4, and the every-state rule of 3 | #657 |
| 3. `tell` and the in port's limit | 5 | #657. It closes [#639](https://github.com/kamp-us/demlik/issues/639), reworded from a docs page to this fix. |
| 4. The answer cell helper | 6 | #657 |

Outside the epic:

- [#640](https://github.com/kamp-us/demlik/issues/640) is its own ticket and is ruled
  ([ADR 0025](./0025-stop-gives-up-on-handlers.md)). It does not run alongside step 3, because both
  change the same `stop()` code.
- [#631](https://github.com/kamp-us/demlik/issues/631) is merged.

Not built now:

- **The fit function (item 7).** The rule is decided here. The function is tea code and gets its own
  demlik ticket when Tuval's move onto these ports starts, which is a phoenix ticket.
- **Matching an ask to its answer by id, and a lock-up detector.** Both wait for a first user.

**Binding constraints.**

- tea keeps no table of runs, finds nothing by name and routes nothing.
- A port's shape checks and never translates.
- An out port has both an `_ok` and an `_err` cell, always.
- `tell` never waits, and host code never decides which of its words is a success.
- No published version of tea has both the old port family and the new `port`.
- A full-line rule other than refusing is a host's, never tea's.

## Consequences

A host gets one source for a port's declaration, listing and check, and a hand-over that cannot
hang. The next host does not write ports again.

The ruling accepts these limits:

- `_ok` means "in the receiver's line", not "handled". After #640, a `stop()` that gives up on a
  hung handler drops what is still in line; the `stop()` error names it.
- `sent` promises less than `queued`. A plain Msg whose cell is gone when its turn comes is dropped
  without a word. A plain Msg has no limit, so a stop notice is never `full`.
- `full` can come from an idle receiver when one loop sends more than the limit. The limit counts
  only Msgs handed over with `tell`; an outside `dispatch` into an in port waits as today.
- A failed save of the receiver goes to the receiver's own error sink. It no longer comes back to
  the sender.
- "Always reports back" holds while the handler itself returns. A handler that dies, or fails with
  a word the port does not declare, goes to the error sink and the machine gets neither `_ok` nor
  `_err`. That is tea's standing rule and Effect's: a typed failure is `_err`, a defect is not.
- A handler can still claim a send on purpose: it can catch a refusal and answer `queued`, or build
  `sent` without calling `tell`. That takes a deliberate line. The careless version does not
  compile, and with types switched off it lands as `_err`.
- After a send to several receivers, an `_err` can mean some of them did get it.
- A broken shape on an in port (a check that throws or is not synchronous) blames the sender: every
  send gets `bad_shape`.
- The define-time refusal is found when the machine loads, not in the editor. It proves some state
  has the cell, not that the cell does anything; an `_ok` or `_err` that arrives in a state without
  it is still refused at run time. It lives in `defineMachine`, so a machine object built by hand
  skips it unless the plan closes that.
- Two machines with the same fields and a different meaning will fit. A "no" between two schema
  libraries may be wrong.
- Two hand-written waiting `dispatch` calls into each other can still hang. There is no lock-up
  detector for now.

**Cost:** removing the old port family breaks every caller of `definePort`, `fromPort`, `ctx.emit`,
`subscribePort` and `emitPort`, and changes the ctx type of every handler.
[`.patterns/tea/elm-canon.md`](../.patterns/tea/elm-canon.md) section 2.12 describes the old
`definePort`, so it goes out of date when the family is removed.

## Records

- **port** is redefined. It now means a typed in or out declaration on a machine. The glossary row
  changes with step 1 of #657, when the old family is removed, so the word never names two things in
  one version.
