---
id: 0034
title: useMachine takes either engine's run, and the Effect engine's is runIn(runtime), never a second hook
status: accepted
date: 2026-11-04
tags: [tea, react, effect, lifecycle]
---

# 0034 — `useMachine` takes either engine's `run`, and the Effect engine's is `runIn(runtime)`, never a second hook

**What this decides:** One `useMachine` drives both engines. The Effect engine reaches it through `runIn(runtime)` on `@demlik/tea/effect`, which turns the caller's `ManagedRuntime` into the `run` the hook takes. The Strict Mode and `<Activity>` lifecycle stays in one place and holds on both engines.

## Context

[#852](https://github.com/kamp-us/demlik/issues/852) asks for the Effect engine under `useMachine`, with the lifecycle [#774](https://github.com/kamp-us/demlik/issues/774) gave the Promise engine: one run per mount under Strict Mode, Subs paused on an `<Activity>` hide, the run stopped on a real unmount. `./react` imports no `effect` specifier, type-only included (`MAINTAINING.md`, import-graph rule 3). The Sub gate that pauses Subs wrapped the Promise engine's runners inside `./react`, so a second hook would have copied the whole lifecycle for an engine whose runners are Streams.

[ADR 0020](./0020-tea-owns-no-dependency-injection.md) says tea owns no DI and uses the caller's runtime as it is. [ADR 0030](./0030-a-sub-failure-closes-the-runs-own-scope.md) says whoever opens a Scope closes it.

## Decision

**`useMachine` stays the one hook, and an engine joins it by passing a `run`, not by adding a hook.**

**`runIn(runtime)` is the bridge.** It returns a `run` whose handle is the run's whole surface from the first instant. Each call opens a `Scope` of its own and `stop()` closes it, once (ADR 0030). The runtime is the caller's, used untouched: never built, cached or disposed by tea (ADR 0020). It returns the same function for the same runtime, because the hook keys its run on `run`'s identity. A Msg sent before an async Layer is built is held and folds in order once it is. A Layer that fails ends the run before it began, reaching `onError` once under `phase: "boot"`.

**The Sub gate sits at the loop seam, not in `./react`.** The hook hands `run` a symbol-keyed option (`src/internal/engine/sub-gate.ts`), and both engines pass it to `startLoop` as `LoopConfig.gate`. The loop starts each Sub through the gate, so it pauses Streams and Promise runners alike, and `MountedRun` is unchanged.

**An engine says what its handlers are in the type of its `run`.** `EngineRun` and `RunOptions` take a handler family (`HandlerFamily`, `PromiseHandlers` by default), carried by the phantom `"~demlik/tea/handlers"` key on `run`. `useMachine` reads the family from `run` alone, so its declaration names no Effect type, and a cell that returns a Promise, or reads a service the runtime lacks, does not compile beside `runIn(runtime)`.

**Binding constraints.**

- `./react` names no `effect` specifier, type-only included, and `useMachine`'s own declaration names no Effect type.
- A new engine joins `useMachine` with a `run` and a handler family. It adds no hook and no lifecycle code.
- Whatever pauses a Sub for the hook is passed to the loop through the gate option. No engine wraps its own runners for React.

## Consequences

One lifecycle, tested once over an engine table (`src/effect/fixtures/engines.ts`), instead of two that drift. The handler family is a small piece of type machinery (a higher-kinded encoding) that the hook's signature now depends on; it is the price of keeping `effect` out of `./react`. `runIn` is a published name on a stable subpath, so a change to its contract is a semver event.
