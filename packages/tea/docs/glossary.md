# Glossary

The words `@demlik/tea`'s pages use, one entry each, in alphabetical order. Each
entry says what the thing is, names where it is exported, and links the
reference page that lists it and the page that covers the why.

## agent

A machine that alternates a model call with the tool calls the model asked
for. `defineAgent` from
`@demlik/tea/agent` builds one from a model, its tools and instructions, and
`agent.run(input)` drives it to its finished state.
Reference: [`defineAgent`](./reference/agent.md#defineAgent). Why:
[what a resumed agent run keeps](./explanation/durability-model.md#what-a-resumed-agent-run-keeps-the-prompt-it-started-with).

## battery

A published named pattern built over the core: a piece of state and the plain
functions that work on it, such as a retry ladder or a debounce. `battery` is
also an export tier, the one whose subpaths (`@demlik/tea/resilience`,
`@demlik/tea/flow` and the rest) may break in a minor. This is the current
sense. The older "battery layer", the `mount*` and `with*` wrappers that wired
a battery into a machine for you, was removed, and a battery is now wired by
calling its functions from `update`.
Reference: [the module list, by tier](./reference/index.md). Why:
[what each import is allowed to do to you](./explanation/export-tiers.md) and
[ADR 0022](../../../.decisions/0022-no-battery-layer-plain-functions.md).

## battery slice

The part of a Model that one battery owns. The battery's verbs take the slice
and return the next one, and `liftSlice` from `@demlik/tea` puts that result
back into the Model at the slice's key.
Reference: [`liftSlice`](./reference/tea.md#liftSlice). Why:
[what each import is allowed to do to you](./explanation/export-tiers.md).

## cell

One entry of a map keyed by type. An `update` cell is the function for one Msg
type, or for one state and one Msg type in the transitions form. An `interpret`
cell is the handler for one Cmd type, typed as `InterpretCell` in `@demlik/tea`.
Reference: [`InterpretCell`](./reference/tea.md#InterpretCell). Why:
[which update form, and what a missing cell means](./explanation/pick-an-update-form.md).

## child

A machine a host runs under a parent machine, in a scope of its own inside the
parent's scope. tea has no supervisor, so the host keeps the table of live
children. Three helpers from `@demlik/tea/effect` run the steps that race:
`spawn` starts a child, `stop` stops one, and `tell` sends the parent a Msg
when a child stops.
Reference: [`spawn`](./reference/effect.md#spawn),
[`stop`](./reference/effect.md#stop) and
[`tell`](./reference/effect.md#tell). How:
[Run many machines under one parent](./how-to/run-many-machines.md).

## Cmd

A plain object, tagged by `type`, that describes one piece of work for the
engine to do once. `update` returns Cmds beside the next Model, a handler
performs each one, and its result comes back as a Msg. `Cmd` is exported from
`@demlik/tea`, and `Cmd.define` declares a Cmd with its input, result and
failure tags.
Reference: [`Cmd`](./reference/tea.md#Cmd). Why:
[Cmd or Sub](./explanation/cmd-or-sub.md).

## ctx

The value you pass to `run` as `ctx`, handed to `init`, to every handler and to
every Sub runner. It carries what the machine's surroundings supply: clients,
configuration, clocks. A machine that needs none may omit it; the argument is
typed by `CtxArg` in `@demlik/tea`.
Reference: [`CtxArg`](./reference/tea.md#CtxArg). Why:
[why failures are values and bugs are throws](./explanation/errors-as-data.md#where-the-two-kinds-show-up-in-the-types).

## dispatch

The function that hands one Msg to a running machine. It is a method of the
handle `run` returns, typed as `RunHandle` in `@demlik/tea`, and a Sub runner
receives one to deliver what it observes.
Reference: [`RunHandle`](./reference/tea.md#RunHandle). Why:
[Cmd or Sub](./explanation/cmd-or-sub.md).

## door

A published import path: one subpath of the package's export map, such as
`@demlik/tea/promise` or `@demlik/tea/jev`. The root door is `@demlik/tea`
itself. Each door carries one tier.
Reference: [the module list, by tier](./reference/index.md). Why:
[what each import is allowed to do to you](./explanation/export-tiers.md).

## engine

The code that runs a machine: it folds each Msg, saves the Model, performs the
Cmds and opens the Subs. There are two, each exporting `run`. The Promise
engine is `@demlik/tea/promise`, whose handlers return Promises. The Effect
engine is `@demlik/tea/effect`, whose handlers return Effects. One machine file
runs on either.
Reference: [`@demlik/tea/promise`](./reference/promise.md) and
[`@demlik/tea/effect`](./reference/effect.md). Why:
[what durability actually promises](./explanation/durability-model.md).

## fold

To apply `update` to one Msg and get the next Model and its Cmds. Folding a
list of Msgs in order is what `replay` and `foldMsgs` from `@demlik/tea` do.
Reference: [`foldMsgs`](./reference/tea.md#foldMsgs). Why:
[Cmd or Sub](./explanation/cmd-or-sub.md).

## handler

The function that performs one Cmd type. You write it and pass it to `run`
inside `interpret`. For a Cmd declared with `Cmd.define` it returns an outcome,
success or a declared failure, and the engine builds the Msg from it. The
handler's type is `InterpretCell` in `@demlik/tea`.
Reference: [`InterpretCell`](./reference/tea.md#InterpretCell). Why:
[why failures are values and bugs are throws](./explanation/errors-as-data.md).

## interpret

The map from Cmd type to handler that you pass to `run`. It has one cell per
Cmd type the machine can return, and its type is `Interpret` in `@demlik/tea`.
A machine that returns no Cmds needs none.
Reference: [`Interpret`](./reference/tea.md#Interpret). Why:
[Cmd or Sub](./explanation/cmd-or-sub.md).

## Jev

TypeSafe Jev, a service by System One that answers a map of typed questions
with a typed answer under each name. `@demlik/tea/jev` is the battery for it. It
holds the wire contract, one Cmd that asks, and a batching composition; the
HTTP call is a handler you write.
Reference: [`@demlik/tea/jev`](./reference/jev.md). Why:
[what each import is allowed to do to you](./explanation/export-tiers.md).

## lid

`defineAgent` from `@demlik/tea/agent`: the short form that builds an agent
from a model, tools and instructions. `createAgent`, in the same subpath, is
the longer form underneath it.
Reference: [`defineAgent`](./reference/agent.md#defineAgent) and
[`createAgent`](./reference/agent.md#createAgent). Why:
[ADR 0015](../../../.decisions/0015-hide-the-wiring-never-the-state.md).

## machine

The plain object `defineMachine` from `@demlik/tea` returns: an `init`, an
`update` and, optionally, the Subs it wants. It holds no handlers and imports
no engine. Its type is `Machine`.
Reference: [`defineMachine`](./reference/tea.md#defineMachine). Why:
[which update form, and what a missing cell means](./explanation/pick-an-update-form.md).

## Model

The machine's whole state, as one plain value. `init` produces the first one,
`update` returns the next one, and a Store saves it. You name its type once,
under `types.model` in `defineMachine` from `@demlik/tea`.
Reference: [`MachineTypes`](./reference/tea.md#MachineTypes). Why:
[what durability actually promises](./explanation/durability-model.md).

## Msg

A plain object, tagged by `type`, that tells the machine something happened: a
user action, a Cmd's result, a Sub's event. A machine changes only by folding a
Msg. You name the union once, under `types.msg` in `defineMachine` from
`@demlik/tea`.
Reference: [`MachineTypes`](./reference/tea.md#MachineTypes). Why:
[Cmd or Sub](./explanation/cmd-or-sub.md).

## replay

The function from `@demlik/tea` that folds a list of Msgs through a machine and
returns the final Model with the Cmds and Subs that fold produced. It performs
no Cmd and opens no Sub.
Reference: [`replay`](./reference/tea.md#replay). Why:
[what durability actually promises](./explanation/durability-model.md).

## run

The function that starts a machine on an engine. It takes the machine and the
`ctx`, `interpret`, `subscribe` and `store` the machine needs, and returns a
handle that is still booting. Each engine exports its own. `run` from
`@demlik/tea/promise` returns a `BootingRuntime`; `run` from
`@demlik/tea/effect` returns an Effect that yields an `EffectBootingRuntime`.
On both, the handle has `dispatch` and `stop`, and its `ready` gives the
runtime.
Reference: [`run` on the Promise engine](./reference/promise.md#run),
[`run` on the Effect engine](./reference/effect.md#run),
[`BootingRuntime`](./reference/tea.md#BootingRuntime) and
[`EffectBootingRuntime`](./reference/effect.md#EffectBootingRuntime). Why:
[what durability actually promises](./explanation/durability-model.md).

## runtime

The booted handle for one running machine. `run` does not return it: you get
it from `ready` on the handle `run` returns, once `init` has run. It keeps that
handle's `dispatch` and `stop` and adds `getState`, plus `idle` and `done` to
wait for the machine to go idle or finish. On the Promise engine `ready` is a
Promise of a `Runtime`, typed in `@demlik/tea`; on the Effect engine it is an
Effect of an `EffectRuntime`, typed in `@demlik/tea/effect`.
Reference: [`Runtime`](./reference/tea.md#Runtime) and
[`EffectRuntime`](./reference/effect.md#EffectRuntime). Why:
[what durability actually promises](./explanation/durability-model.md).

## Store

The interface an engine saves the Model through: `load`, `migrate` and `save`.
It is exported from `@demlik/tea`. `memoryStore` in `@demlik/tea/mem`,
`fileStore` in `@demlik/tea/node` and `doStore` in `@demlik/tea/do` implement
it.
Reference: [`Store`](./reference/tea.md#Store). Why:
[what durability actually promises](./explanation/durability-model.md).

## Sub

A plain object, `{ type, deps }`, that names something to watch for as long as
the Model asks for it. The engine opens it with a Sub runner, the function for
that Sub type you pass to `run` under `subscribe`, and each event the runner
sees arrives as a Msg. `Sub` is exported from `@demlik/tea`; the `timer` Sub is
built in.
Reference: [`Sub`](./reference/tea.md#Sub) and
[`Subscribe`](./reference/tea.md#Subscribe). Why:
[Cmd or Sub](./explanation/cmd-or-sub.md).

## tool

One thing an agent's model may call. `tool` from `@demlik/tea/agent` declares
its name, its input and result schemas, the failures it may name, and the
handler that does the work.
Reference: [`tool`](./reference/agent.md#tool). Why:
[why failures are values and bugs are throws](./explanation/errors-as-data.md).

## update

The machine's one pure function, written as a map of cells. Given the Model and
a Msg it returns the next Model and a list of Cmds, and it performs no work
itself. Its two forms are typed as `Reducer` and `Transitions` in `@demlik/tea`.
Reference: [`Reducer`](./reference/tea.md#Reducer) and
[`Transitions`](./reference/tea.md#Transitions). Why:
[which update form, and what a missing cell means](./explanation/pick-an-update-form.md).

## verb

One of a battery's plain functions. It takes the battery's slice and returns
the next slice with the Cmds it wants run. `liftSlice` from `@demlik/tea` takes
a verb's result.
Reference: [`liftSlice`](./reference/tea.md#liftSlice). Why:
[what each import is allowed to do to you](./explanation/export-tiers.md).
