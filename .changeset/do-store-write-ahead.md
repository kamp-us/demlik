---
"@demlik/tea": minor
---

**Breaking:** Remove `EventSourcedStore.append` from `@demlik/tea/do`. Pass `doEventSourcedStore(...).store` directly to `run`; remove observer-based and manual pre-dispatch append wiring. The engine supplies each applied message through `save` and awaits its event write before commands run. Removing the old wiring avoids recording messages twice.

Existing raw message logs, metadata and snapshot envelopes remain readable without rewriting. Snapshot cadence and the public event reader retain their formats.

Removed: an unexported internal workflow wrapper that fed this store from `runtime.observe`. No export reached it, and the published `./flow` names are unchanged.
