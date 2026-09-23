---
id: 0020
title: Dependencies belong to the handler, never to tea's core or its Cmds
status: accepted
date: 2026-09-22
tags: []
---

# 0020 — Dependencies belong to the handler, never to tea's core or its Cmds

**What this decides:** tea is a state machine library and does no dependency injection. The
`provide` / `layer` graph and the `R` channel on Cmds go away. A handler gets its services the way
its own world does: a plain `ctx` object for Promise handlers, and Effect itself for Effect
handlers.

## Context

[0014](./0014-typed-effect-channels-on-cmd-constructors.md) took two of Effect's channels onto Cmd
constructors as types: `E` for failures and `R` for requirements.
[0019](./0019-a-host-side-provider-graph-satisfies-r.md) then built the thing that satisfies `R`: a
host-side provider graph (`provide` / `layer` / `value`) that copies Effect's `Layer` + `Scope`
point for point. Both were careful work. 0019 in particular named a real gap, since no resource
in the package had a managed lifetime.

Where tea is heading has changed the question. https://github.com/kamp-us/demlik/issues/36,
reopened as an epic on 2026-09-22, splits demlik into a core that knows neither `Promise` nor
`Effect`, plus two engines: `tea-promise` (today's `run()`) and `tea-effect`. Userland async lives
in handlers, and a handler is either Promise-based or Effect-based. Seen that way:

- **Effect users already have DI.** An Effect handler's own `R` names what it needs, and a `Layer`
  at the edge provides it, with real `Scope`, memoization and finalizers. A tea-owned copy of that
  contract is a second one to learn and to keep in sync. kamp-us/phoenix's tuval already runs
  demlik this way: its handlers are `Effect<Msg[], E, R>`, and it never touches `provide`.
- **Promise users never needed it.** Both known production consumers run on a plain `ctx`.
  binclusive/monorepo (pinned `@demlik/tea` 0.5.0) builds machines with
  `defineMachine({ init, update, interpret })`, runs them with `run(machine, { ctx })` and
  `useMachine(machine, { ctx, store })`, and reads `ctx.config` inside `init`. cansirin/monorepo
  (`^0.5.0`, about 16 subpaths) is the same shape. Neither one uses `provide`, `layer` or `R`.
- **`R` on a Cmd describes the handler, not the Cmd.** A Cmd is journaled data. Which services
  run it is a fact about whoever interprets it, and that changes per engine. `E` is different: a
  Cmd's failures come back into `update` as Msgs, so they are state machine business.

This supersedes 0019 outright and amends 0014 in part: 0014's `E` half and its core rule (no
`Effect` value at the core) stand, and its `R` half is withdrawn.

## Decision

**tea's core does no dependency injection: a handler gets its services from its engine's own
world, and a Cmd carries no `R`.**

1. **The provider graph is removed.** `provide`, `layer`, `value`, `Provided`, `ScopedCtxArg`,
   `ProvideFailedError`, `UnknownProviderError`, `ProviderCycleError` and the `"provide"` runtime
   error phase leave the package. The removal lands in a minor at 0.x, per
   [0016](./0016-removal-lands-in-a-minor-at-0x.md).
2. **`R` leaves the Cmd.** `Cmd.requirements`, `RequirementsOf`, `Requirements` and the
   requirement half of `RequiredCtx` are removed. A Cmd type is `Cmd<Type, Ok, E>`.
3. **`E` stays, unchanged.** A Cmd constructor still names the `_tag` union it can settle with,
   and the error cell in `update` is still exhaustively typed
   ([0011](./0011-errors-as-data.md), 0014).
4. **The Promise path stays as it is today.** `ctx` is a plain object handed to `run` /
   `useMachine` / the adapters. `init` may read it. `interpret` handlers return
   `Promise<Msg | void>`. Code written against 0.5.0 in this shape keeps working.
5. **The Effect path uses Effect for DI.** A `tea-effect` handler is an `Effect` whose own `R` is
   satisfied by whatever `Layer` or `Context` the caller runs the engine with. tea passes that
   through untouched and adds no graph, no memoization and no lifetime rules of its own.

**Banned.**

- A tea-owned provider, layer, container or service registry, in the core or in either engine.
- A requirements type parameter on `Cmd`, `Msg`, `Sub` or `Machine`.
- A Promise-path change that makes a 0.5.0-shape consumer (`defineMachine` + Promise `interpret`
  + plain `ctx`) write anything new.

## Consequences

- About 1,000 lines in `src/provide/` go, plus the `R` plumbing in `run.ts`, `runtime-types.ts`,
  `agent/tool.ts` and `testing/drive.ts`. The import-order note in `src/index.ts` that points at
  `provide` needs rewording.
- A Promise host with a resource writes its own try/finally around `run` again, as it did before
  0019. That is the cost. An Effect host gets `Scope` for free, which is where 0019's lifetime
  guarantees were always heading (its last consequence says so).
- The `tea-effect` engine in #36 has one less thing to design: it forwards Effect's `R` and never
  maps it onto a tea graph.
- Nothing journaled changes. 0019 already kept providers out of the journal, and `R` was
  type-only.

## Amendments

- **#251 R1.1 — the Promise path may change; 0.5.0 compatibility is not a constraint
  (2026-09-22).** Decision item 4 ("the Promise path stays as it is today … code written against
  0.5.0 in this shape keeps working") and the third **Banned** line (no Promise-path change that
  makes a 0.5.0-shape consumer write anything new) are withdrawn. Session
  https://github.com/kamp-us/demlik/issues/251 ruled that `interpret` comes off `Machine` and that
  handlers arrive at run time on both engines (R1.1), under one name per concept, `run` /
  `interpret` / `subscribe` (R1.2, R1.3). A consumer on the 0.5.0 shape stays pinned until it
  migrates. What still holds: `ctx` remains a plain object on the Promise engine, and tea still
  owns no DI on either engine. The rest of this decision is unchanged.

## Records

no vocabulary impact
