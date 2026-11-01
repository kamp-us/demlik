---
"@demlik/tea": minor
---

**Breaking: `tell` is now a compile error on anything but the handle `ready` gives.** `tell` puts a Msg on a run's line, and a hand-built handle has none. That mistake used to compile and fail at run time: a throw on the Promise engine, and a defect on the Effect engine that ended `spawn`'s `notify` unseen, so the parent was never told a child stopped.

- `ready` now gives a type that carries the line: `Run` on `@demlik/tea/promise`, `EffectRun` on `@demlik/tea/effect`. Each extends the type it replaces, so it fits anywhere that type is asked for. A spread of one keeps its line.
- `run` now gives `BootingRun` on `@demlik/tea/promise` and `EffectBootingRun` on `@demlik/tea/effect`. Each extends the type it replaces, and its `ready` gives the type above.
- `tell` asks for `Run` or `EffectRun`. A `Runtime`, `EffectRuntime`, `BootingRuntime` or `EffectBootingRuntime` that is not one no longer compiles as its argument, and neither does `noopRuntime()`. Change a host's own annotation from `EffectRuntime` to `EffectRun`, or from `Runtime` to `Run`, on any handle it passes to `tell`.
- `Runtime` and `EffectRuntime` are unchanged, so host fakes and `noopRuntime` stay valid as those types.
- This narrows `run`'s handle: it does not compile as `tell`'s argument, with a store or without one, so what compiles does not depend on whether a run has a store. A storeless host that told before `ready` must now wait for it. On a store-backed run that call could lose the Msg.
- A hand-built object cast past the type still has no line: `tell` throws on the Promise engine and dies with a defect on the Effect engine.
