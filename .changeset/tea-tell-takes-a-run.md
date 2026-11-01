---
"@demlik/tea": minor
---

**Breaking: `tell` is now a compile error on a handle that did not come from `run`.** `tell` puts a Msg on a run's line, and a hand-built handle has none. That mistake used to compile and fail at run time: a throw on the Promise engine, and a defect on the Effect engine that ended `spawn`'s `notify` unseen, so the parent was never told a child stopped.

- `run` and `ready` now give types that carry the line: `BootingRun` and `Run` on `@demlik/tea/promise`, `EffectBootingRun` and `EffectRun` on `@demlik/tea/effect`. Each extends the type it replaces, so it fits anywhere that type is asked for. A spread of one keeps its line.
- `tell` asks for that type. A `Runtime`, `EffectRuntime`, `BootingRuntime` or `EffectBootingRuntime` that is not one of these no longer compiles as its argument, and neither does `noopRuntime()`. Change a host's own annotation from `EffectRuntime` to `EffectRun`, or from `Runtime` to `Run`, on any handle it passes to `tell`.
- `Runtime` and `EffectRuntime` are unchanged, so host fakes and `noopRuntime` stay valid as those types.
- A handle still booting now compiles as `tell`'s argument. It has no State yet, so it answers `"no_cell"` and the Msg is not on its line. Wait for `ready` first.
- A handle cast past the type still has no line: `tell` throws on the Promise engine and dies with a defect on the Effect engine.
