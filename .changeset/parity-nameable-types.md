---
"@demlik/tea": patch
---

`@demlik/tea/parity` now re-exports `Trace` and `RecorderOptions` as types.

Both already appeared in the door's published signatures — `Recording.trace()` returns a
`Trace<S, M>`, `goldenReplay` accepts one bare, `recordRun` takes `RecorderOptions` — but
neither had a name a consumer could import once `@demlik/tea/recorder` went internal. So
annotating a fixture, typing an options constant, or giving a wrapper an explicit return type
meant `ReturnType<typeof rec.trace>`.

```ts
import { goldenReplay, type RecorderOptions, type Trace } from "@demlik/tea/parity";

const opts: RecorderOptions = { captureSteps: true };
const golden: Trace<AuditState, AuditMsg> = JSON.parse(fixture);
```

No runtime change and no `exports` change: this widens the type surface inside an existing
door. `docs/how-to/gate-a-refactor-on-parity.md` names `Trace` directly now.
