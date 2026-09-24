---
"@demlik/tea": minor
---

A Sub that fails with an error it did not handle now stops the run instead of
being logged and left counted as running (#309). This is the Elm way: a Sub
maps the errors it expects into Msgs itself, and anything else is fatal.

- **Effect engine:** a Sub's `Stream` that fails (anything but an interrupt)
  reaches `onError` under the new `"sub"` phase, and the engine closes the run's
  Scope with that failure, which stops the run. Before, it was reported under
  `"follow-up"` and the dead Sub stayed registered, so the run looked healthy.
- **Promise engine:** a runner that throws while it starts still rejects the
  dispatch (or `ready`) that started it, and now also reaches `onError` under
  `"sub"` and stops the run.

There is no `subFailure` hook on the machine or on `run`. To keep a run going
through an error you expect, turn it into a Msg in the Sub, e.g. with
`Stream.catchTag` on the Effect engine. See "Turn a Sub's errors into Msgs" in
the Effect engine how-to.

**Breaking:** a Promise-engine runner that throws while starting used to leave
the run alive; it now stops it. `RuntimeErrorPhase` gains `"sub"`, so an
exhaustive `switch` over it needs a new case.
