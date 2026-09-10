---
id: 0019
title: A host-side provider graph satisfies R, copying Effect's Layer + Scope
status: accepted
date: 2026-09-09
tags: []
---

# 0019 — A host-side provider graph satisfies R, copying Effect's Layer + Scope

**Scope:** how a resource with a lifetime — a db handle, a pool, a temp directory — gets built
for a run and torn down at the end of it. Applies [0014](./0014-typed-effect-channels-on-cmd-constructors.md)
(`E` and `R` are types on Cmd constructors, never Effect values at the core) to the layer 0014
deliberately left empty, and stays inside [0015](./0015-hide-the-wiring-never-the-state.md) (a
convenience layer hides the wiring, never the state). Records the ruling on #183.

**What this decides:** the provider graph lives in the HOST, not on the Cmd; its contract is
Effect's `Layer` + `Scope`, copied point for point; `run` accepts a graph wherever it accepts a
`ctx`, acquires it at boot and releases it at `stop()`; and the journal never sees any of it.

## Context

ADR 0014 ruled that a `Cmd` is journaled data, so it can carry Effect's channels only as PHANTOM
types. `R` — Requirements — was the honest half of that ruling and the unfinished one: a Cmd
declares which slice of `ctx` its handler reads, `run` demands the intersection, and every host in
this repo then satisfied it by building one `ctx` object by hand before `run` and letting the
process end. No resource in the package had a managed lifetime. An Effect reviewer named the gap
exactly: "scope a resource across the run: no Layer, no finalizers, no interruption."

The tempting fix — put the provider on the Cmd — is the one 0014 already refused, and for a reason
that has not changed: a provider is a closure, a Cmd is data that survives a `Store<S>` round-trip,
and a closure does not. But nothing in 0014 forbids the HOST from having a graph. The requirement
is a type; a type needs no closure; the thing that satisfies it is ordinary host wiring, one layer
out from the journal.

The second question was whose contract to copy. `Layer`/`Scope` (and `ZLayer`/`Scope` before it)
has a decade of production behind it, and every rule in it is there because someone was bitten:
memoization because a diamond acquires twice otherwise, reverse release because teardown order is
the inverse of construction order, isolated finalizers because one failing `close` must not strand
the rest. Inventing a fourth contract would only be a fourth one to learn.

## Decision

**1. The graph is host-side, and it produces the `ctx` that already exists.** `provide({ … })`
returns an unopened graph; opening it yields the same `Ctx` object `run` has always taken. Nothing
about `Cmd`, `RequiredCtx` or the interpret seam changes — a handler still reads `ctx.db`, typed
exactly as before. `R` is the requirement; the graph is what satisfies it.

**2. The contract is Effect's, point for point.** A provider is `acquire` plus an optional
`release`, and an `acquire` may depend on siblings. Built once per scope in dependency order and
MEMOIZED. Released in REVERSE acquisition order, exactly once. A `release` that throws does not
stop the others. An `acquire` failure releases what was already acquired, in reverse, before it
surfaces. Names follow Effect: `provide` satisfies `R`, and `R` glosses as **Requirements**.

**3. `run` owns the lifetime, and `stop()` is the release point.** A graph handed to `run` as
`ctx` is opened as the first thing boot does and released as the last thing `stop()` does. Every
terminal reaches it: `driveToDone` stops in a `finally`, so a done run, a `failed` run and a
cancelled run (#147) all release, without a fourth code path per terminal. A host that wires its
own `ctx` can open the graph itself (`Provided.open()`) and hold the `Scope`.

**4. An acquire failure is a typed failure, never a throw out of `run`.** Per
[0011](./0011-errors-as-data.md) a failure with a next move is not a panic: a `ProvideFailedError`
naming the provider rejects `ready` and is reported to `onError` under `phase: "provide"`. The
wiring being WRONG is the other kind — an unknown dependency name or a cycle is a contract breach
and throws (`UnknownProviderError`, `ProviderCycleError`), because no run can fix it.

**5. The journal never sees a provider.** Replay is a fold over Msgs (0014) and a fold calls no
handler, so it calls no `acquire`. A run on a graph writes byte-identical bytes to the same run on
a hand-built `ctx`. This is the invariant that keeps the graph a convenience layer under 0015: it
hides the wiring, and the state stays exactly as visible as it was.

**6. It lands on the root door, not a subpath.** `/node`, `/do` and `/mem` are `Store` adapters;
the graph sits at `run`'s `ctx` seam, which all three share, so there is no host-specific half to
put behind a door of its own.

## Consequences

- A host with a resource stops writing its own try/finally around `run` and stops getting the
  cancelled case wrong.
- `run`'s `ctx` field widens to `ScopedCtxArg` — the object OR the graph. The other `CtxArg` sites
  (`replay`'s seed) stay narrow on purpose: a pure fold has no boot to acquire in and no terminal
  to release at, so widening them would promise a lifetime nothing there could honour.
- One new `RuntimeErrorPhase`, `"provide"`, and one optional `provider` field on
  `RuntimeErrorContext` — a throwing `release` has no caller to reject at, the run being over.
- The tea-effect split (#36/#37) can later map a real Effect `Layer` onto this shape. Nothing here
  depends on Effect.

## Amendments

- **#186 — item 4: `UnknownProviderError` is no longer reachable from a map `provide` typechecked.
  A provider's dependency NAMES are now bound to `keyof M`, the way Effect's `Layer<ROut, E, RIn>`
  makes requirements a type parameter, so a misspelled dependency is a compile error at the call
  site instead of a boot-time throw. The error class stays for the untyped path — a cast map, one
  assembled at runtime, one read back through an erased `Provider<unknown, …>` — where there was
  never a key set to check against. Ruling: Can, 2026-09-09, on
  https://github.com/kamp-us/demlik/issues/186.**
