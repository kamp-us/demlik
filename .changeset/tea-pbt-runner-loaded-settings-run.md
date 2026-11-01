---
"@demlik/tea": minor
---

`propertyTerminates`, `propertyInvariant` and `propertyTrace` (`@demlik/tea/pbt`) gain three things:

- **Drawn saved states.** `loaded` takes an `fc.Arbitrary<S>` as well as a value. The state is drawn per run, and a failure's counterexample shows it beside the shrunk list. A fixed `loaded`, `null` or none draws what it drew before.
- **fast-check's settings.** The runners forward fast-check's `Parameters`, such as `path` to replay a failure, `endOnFailure`, and `interruptAfterTimeLimit` with `markInterruptAsFailure`. `numRuns` still defaults to 200. `reporter` and `asyncReporter` (they stop a failure from throwing), `examples` (its shape depends on what is drawn) and `timeout` (it applies only to async properties) are left out, and passing one is a compile error.
- **`PropertyRun` and `PropertyFailure`, two new exports.** Each runner returns a `PropertyRun` with `numRuns`, `numShrinks`, `seed` and the failing `path`. A failing run throws a `PropertyFailure`, an `Error` whose message is fast-check's report and whose `run` field holds that same `PropertyRun`.

**Breaking (declaration only):** the published signatures of `stable` names changed, so the API ratchet asks for this callout. The runners now return a value where they returned `void`, and the options are wider. No existing call needs editing and no existing seed draws anything new.
