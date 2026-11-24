---
"@demlik/tea": minor
---

**Breaking (types only):** `StepTransport` and `ExecuteStep` (`@demlik/tea/do`) are now called with a second argument, `{ signal }`, and `RunStepLoopConfig.sleep` with `(ms, signal)`. A function that declares fewer parameters still fits, so implementations compile unchanged. What breaks is code that calls such a value itself, such as a wrapper that forwards to an inner `ExecuteStep` with one argument: it must now pass the second argument. `StepLoopMsg` gains a `deadline_passed` variant, so an exhaustive `switch` over it needs one more case. The injected `now` and `sleep` are called in the same sequence as before.

`runStepLoop` ends a drive with `deadline_exceeded` when `deadlineMs` falls due, even while a `/step` POST, a backoff or poll sleep, or `execute` is still pending.

Before, the loop read the clock only between effects, so a transport that long-polled or a step that hung overran the deadline by the length of that wait. Now the drive runs `stepLoopMachine` with `run`'s `cancellation`. A `setTimeout` owned by the drive, armed at its first clock read for `deadlineMs - now()`, aborts the cancellation's signal. The runtime then folds a new `deadline_passed` Msg to `deadline_exceeded` and stops waiting on the work in flight. That Msg is recorded, so `replayTrace` of such a drive reaches the same final State.

The `signal` handed to the transport, `execute` and `sleep` aborts at the deadline or when the drive is over. Pass it to `fetch` so the abandoned work stops. The timer is armed again for the remainder when it fires before `now()` reaches the deadline, and in parts for a deadline more than 2^31-1 ms away. It is cleared when the drive returns, so the process can exit as soon as it does. `deadlineMs: Infinity` arms no timer.
