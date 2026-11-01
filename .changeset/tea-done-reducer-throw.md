---
"@demlik/tea": minor
---

**`done()` can now fail after a reducer throw.** It used to wait forever.

- The failed `done()` does not clean up the run. A reducer throw under `stop` refuses every later Msg and fails `done()`, but the Subs keep running, the final save has not happened, and the run's Scope stays open. All three wait for the host's `stop()` or the Scope closing, so a host that hears this failure still has to call one of them.
- Under the default `stop` strategy, a reducer throw now fails `done()` with that error, for waiting and later callers. On the Promise engine it rejects with what was thrown. On the Effect engine it ends as a defect holding what was thrown, and `done()`'s type stays `Effect<S, StoreFailed | SubFailed>`, the same way a dispatch hit by that throw ends. `Effect.catchTags` does not see a defect, so read it with `Effect.catchDefect` or from the fiber's `Exit`.
- On the Promise engine, a `done()` with no catch now raises an unhandled rejection in this case, which ends a Node process by default. Add a catch to every `done()` you do not await.
- The Msgs already in line fold first, so if one of them reaches a terminal State, that State is the answer for every caller and for `result()`. A terminal State saved before the throw keeps its answer too. If a Sub failure closed the run first, `done()` keeps the Sub's answer.
- `escalate` and `restart` keep the run live and leave `done()` waiting, a Msg with no cell is still a refusal, and a plain `stop()` with no failure still leaves `done()` pending.
