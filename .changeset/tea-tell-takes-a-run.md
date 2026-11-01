---
"@demlik/tea": minor
---

**Breaking: `tell` is now a compile error on anything but the handle `ready` gives.** A hand-built handle compiled and worked on the Effect `tell` until now. This release puts each Msg on a run's line, and such a handle has none, so the type now refuses it.

- `ready` now gives a type that carries the line: `Run` on `@demlik/tea/promise`, `EffectRun` on `@demlik/tea/effect`. Each extends the type it replaces, so it fits anywhere that type is asked for. A spread of one keeps its line.
- `run` now gives `BootingRun` on `@demlik/tea/promise` and `EffectBootingRun` on `@demlik/tea/effect`. Each extends the type it replaces, and its `ready` gives the type above.
- `tell` asks for `Run` or `EffectRun`. A `Runtime`, `EffectRuntime`, `BootingRuntime` or `EffectBootingRuntime` that is not one does not compile as its argument, and neither does `noopRuntime()`. Change a host's own annotation from `EffectRuntime` to `EffectRun`, or from `Runtime` to `Run`, on any handle it passes to `tell`.
- `Runtime` and `EffectRuntime` are unchanged, so host fakes and `noopRuntime` stay valid as those types.
- This narrows `run`'s handle: it does not compile as `tell`'s argument, with a store or without one, so what compiles does not depend on whether a run has a store. A storeless host that told before `ready` must now wait for it. On a store-backed run that call could lose the Msg.
- A hand-built object cast past the type still has no line: `tell` throws on the Promise engine and dies with a defect on the Effect engine.
