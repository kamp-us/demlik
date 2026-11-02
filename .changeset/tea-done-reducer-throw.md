---
"@demlik/tea": minor
---

**Breaking: a reducer throw under the default `stop` strategy now stops the run by itself, and `done()` fails with the throw.** `done()` used to wait forever, and the run stayed half open until the host called `stop()`. ADR 0033 records the owner's ruling.

- The run stops the way a Sub failure stops it. The Msgs already in line fold first, then the Subs close, the final save runs, and on the Effect engine the run's own Scope closes. The Scope you ran it in stays open. A worker started with `spawn` leaves your table and its `notify` runs, so its parent hears `child_stopped`.
- A `stop()` from the host afterwards, or closing your Scope, does nothing more: no second save, no second close. A host that already called `stop()` after a failed `done()` stays correct.
- A host that kept using a run's Subs or Scope after a reducer throw, until its own `stop()`, now finds them closed. Move that work out of the run, or catch the throw with `escalate` or `restart`.
- `done()` fails with what was thrown, for waiting and later callers. On the Promise engine it rejects with it. On the Effect engine it ends as a defect holding it, and `done()`'s type stays `Effect<S, StoreFailed | SubFailed>`, the same way a dispatch hit by that throw ends. `Effect.catchTags` does not see a defect, so read it with `Effect.catchDefect` or from the fiber's `Exit`.
- On the Promise engine, a `done()` with no catch now raises an unhandled rejection in this case, which ends a Node process by default. Add a catch to every `done()` you do not await.
- If a Msg already in line reaches a terminal State, that State is the answer for every caller and for `result()`. A terminal State saved before the throw keeps its answer too. If a Sub failure closed the run first, `done()` keeps the Sub's answer.
- `escalate` and `restart` keep the run live and leave `done()` waiting, a Msg with no cell is still a refusal, and a plain `stop()` with no failure still leaves `done()` pending.
