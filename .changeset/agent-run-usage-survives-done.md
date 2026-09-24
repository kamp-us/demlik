---
"@demlik/tea": minor
---

`./agent`: a run's usage total survives `done`, and a checkpoint holds the
pending prompt once (#354).

- **The total is on the run.** The running usage total moves from
  `conversation.usage` to `state.usage`. It is the one field that holds it, and
  the retire to `done` no longer clears it with the conversation. `status(state)`'s
  `done` arm carries it as `usage`, so `RunDone`'s `done` status does too. A
  token budget reads `stopWhen: ({ usage }) => …`. `conversation.contextTokens`
  stays where it was.
- **The outbox no longer copies the brain request.** The `brain_started`
  lifecycle note drops its `payload`. The request is already held on the brain
  call's resilient slice, so a Model saved mid-brain-call carries the prompt,
  images included, once instead of twice. `BrainStarted` events keep the same
  `purpose`, `model` and `payload`.
- **Older Models still load.** A Model that kept its total on
  `conversation.usage` has it moved onto `state.usage` by the first transition.
  A 0.17.x Model starts its total from zero, as before. A `done` Model saved
  before this change had already lost its total, so it reports zero.
