---
"@demlik/tea": minor
---

**Breaking (types only):** `StepTransport`, `ExecuteStep` and `RunStepLoopConfig.sleep` (`@demlik/tea/do`) are now called with a second argument, `{ signal }` for the first two and `signal` for `sleep`. Code that implements them with one parameter still compiles. Code that calls one of these values itself, for example a wrapper that forwards to an inner `ExecuteStep`, must pass the second argument. `StepLoopMsg` gains a `deadline_passed` variant, so an exhaustive `switch` over it needs one more case.

`runStepLoop` ends a drive with `deadline_exceeded` when `deadlineMs` falls due, even while a `/step` POST, a backoff or poll sleep, or `execute` is still pending.

Before, the loop read the clock only between effects, so a transport that long-polled or a step that hung overran the deadline by the length of that wait. Now the drive runs `stepLoopMachine` with `run`'s `cancellation`: at the deadline the runtime folds a new `deadline_passed` Msg to `deadline_exceeded` and stops waiting on the work in flight. That Msg is recorded, so `replayTrace` of such a drive reaches the same final State.

The `signal` aborts at the deadline or when the drive is over. Pass it to `fetch` so the abandoned work stops. The deadline timer sleeps through the injected `now` and `sleep`. The default sleep clears its timer on abort, so the process can exit as soon as the drive returns. `deadlineMs: Infinity` arms no timer.
