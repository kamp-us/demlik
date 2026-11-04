---
"@demlik/tea": minor
---

`useMachine` from `@demlik/tea/react` now drives the Effect engine. Pass `runIn(runtime)` from `@demlik/tea/effect`, with your `ManagedRuntime`, as its `run`: `useMachine(machine, { run: runIn(appRuntime), ctx, interpret })`, where each `interpret` cell returns an `Effect` and each `subscribe` runner a `Stream`, within the services the runtime provides. One run starts per mount under Strict Mode, the Subs pause on an `<Activity>` hide, and a real unmount closes the run's `Scope`. A Msg sent before an async Layer is built waits and folds in order, and a Layer that fails reaches `onError` once under `phase: "boot"`. `runIn(runtime)` returns the same function for the same runtime. New on `@demlik/tea/effect`: `runIn`, `BridgedRun`, `EffectHandlers`, `EffectHandlerTables`; new on `@demlik/tea`: `HandlerFamily`, `HandlersFor`, `PromiseHandlers`.

**Additive (declaration only):** `useMachine`, `UseMachineOpts`, `EngineRun` and `RunOptions` take a final type parameter that names the engine whose handlers `run` carries, defaulting to the Promise engine's, so no existing call needs editing. The Effect engine's handle now carries the State a restored `init` installed, so a page reloaded in the middle of work shows it while `init`'s Cmd runs on that engine too (#695). Closes issue 852.
