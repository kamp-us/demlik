---
"@demlik/tea": minor
---

`./agent`: a run's usage total survives `done`, and a checkpoint holds the
pending prompt once (#354).

- **The total outlives the run.** `state.usage` is the one field that holds the
  run's total, and the retire to `done` keeps it. `status(state)`'s `done` arm
  carries it as `usage`, so `RunDone`'s `done` status does too.
- **The outbox no longer copies the brain request.** The `brain_started`
  lifecycle note drops its `payload`. The request is already held on the brain
  call's resilient slice, so a Model saved mid-brain-call carries the prompt,
  images included, once instead of twice. `BrainStarted` events keep the same
  `purpose`, `model` and `payload`.
- **Older Models still load.** A 0.17.x Model starts its total from zero.
