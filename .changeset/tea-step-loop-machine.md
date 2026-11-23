---
"@demlik/tea": minor
---

`runStepLoop` (`@demlik/tea/do`) runs its decisions as a tea machine on `run`: when to POST, what a response means, when to run a step, retry, back off, give up, stop at the deadline or finish. The clock, the transport, the hands and the sleep are its Cmds. `@demlik/tea/do` exports the machine, `stepLoopMachine<R, I, O>()`, and its `StepLoopState`, `StepLoopRun`, `StepLoopMsg` and `StepLoopCmd` types, and `RunStepLoopConfig` takes `attach(runtime)`, called once with the drive's runtime before it boots. `recorder(runtime, { captureSteps: true })` then records a drive, and `replayTrace(stepLoopMachine(), trace)` (or `replayStoredTrace` for a recording read back from JSONL) replays it. The recorded Msgs carry the values each decision read: every clock read, each response, each failure and whether `retryable` allowed it, the result that was posted, and each sleep. The signature, the outcomes, the order of calls and the number of clock reads are unchanged.

**Additive (declaration only):** five new names, `stepLoopMachine`, `StepLoopState`, `StepLoopRun`, `StepLoopMsg` and `StepLoopCmd`. `RunStepLoopConfig` gains the optional `attach` and two type parameters, `I` and `O`, that default to `never`.

**Breaking:** a drive is now one `dispatch`, and tea ends a `dispatch` that has run 100,000 follow-up Msgs with `QuiescenceTimeoutError`. An ordinary step takes three Msgs, so a drive of about 33,000 steps in one call now rejects where the loop it replaced had no bound. Such a caller starts another `runStepLoop` with the same `executed` store, which does not run the steps it already ran.
