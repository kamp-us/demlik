---
"@demlik/tea": minor
---

`propertyTerminates`, `propertyInvariant` and `propertyTrace` (`@demlik/tea/pbt`) gain four things:

- **Drawn saved states.** `loaded` takes an `fc.Arbitrary<S | null>` as well as a value. The state is drawn per run, a drawn `null` boots the machine fresh, and a failure's counterexample shows the drawn value beside the shrunk list. A fixed `loaded`, `null` or none draws what it drew before.
- **fast-check's settings.** The runners forward fast-check's `Parameters`, such as `path` to replay a failure, `endOnFailure`, and `interruptAfterTimeLimit` with `markInterruptAsFailure`. `numRuns` still defaults to 200. `reporter` and `asyncReporter` (they stop a failure from throwing), `examples` (its shape depends on what is drawn) and `timeout` (it applies only to async properties) are left out, and passing one is a compile error. A reporter set through `fc.configureGlobal` works as it did: it takes the details on a pass and on a failure, and nothing throws.
- **`PropertyRun` and `PropertyFailure`, two new exports.** Each runner returns a `PropertyRun` with `numRuns`, `numShrinks`, `seed` and the failing `path`. A failing run throws a `PropertyFailure`, an `Error` whose message is fast-check's report and whose `run` field holds that same `PropertyRun`. What the check threw sits where `fc.assert` puts it on your fast-check: in the error's `cause` on 4 unless `includeErrorInReport` is on, in the message on 3 unless `errorWithCause` is on.
- **`PropertyOpts`, a new type export.** It holds what the runners take, and the reference page shows the docs of each option.

**Breaking (declaration only):** the published signatures of `stable` names changed, so the API ratchet asks for this callout. The runners now return a value where they returned `void`, and the options are wider. No existing call needs editing and no existing seed draws anything new.
