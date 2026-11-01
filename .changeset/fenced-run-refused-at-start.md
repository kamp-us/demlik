---
"@demlik/tea": minor
---

**Breaking: a run on a store that is fenced at runtime, with no `onError`, is now refused at start on both engines.** The type already refused it, but a fenced store held in a variable typed plain `Store<S>`, or passed from JavaScript, got past the type and ran on the default sink, where a lost fence ends the process and every run in it. The Promise engine's `run` now throws at once, and the Effect engine's `run` dies, before anything is loaded or saved. The error names `onError`. ADR 0031 records the owner's ruling.

To migrate, pass an `onError` beside the store. An unfenced store, or no store, still starts with no sink.
