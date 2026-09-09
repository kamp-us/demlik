---
"@demlik/tea": minor
---

A tool failure on `@demlik/tea/agent` (experimental tier) keeps its tag. `ToolOutcome`'s error
arm now carries the `{ _tag, …payload }` the tool failed with, spread beside the `reason` string
it always carried, so the failure the model reads as prose is the same failure host code can
branch on. `toolErrorReason` and the `reason` it renders are unchanged — this is additive (#115).

- `ToolFailure` — the stored error arm, `{ kind: "error", reason, _tag? }`. `_tag` is optional
  for one reason: a run persisted by 0.12.x was written before the tag was kept, so a `Store` can
  hand back a failure that has none. Every failure this version mints carries one.
- `ToolError<T>` / `ToolFailureOf<T>` / `TaggedFailure<E>` — the failure union a router over `T`
  can settle with, and that union distributed over `{ kind, reason }`. Declared tags, `thrown`,
  the kernel's `malformed_result`, the router's `unknown_tool` / `malformed_args`, and the
  ladder's `timeout` / `retry_exhausted` (`ToolResilienceError`, new here: `ToolTimedOut` and
  `ToolRetryExhausted`).
- `DefineAgentConfig.onToolError(outcome, ctx)` — optional, with `outcome` typed against this
  agent's own tools: a `switch` on `_tag` narrows the payload and an unhandled failure mode is a
  compile error. A handler's own failure fires it at the interpret boundary, before the fold;
  `timeout` and `retry_exhausted` are minted by the reducer rather than by a handler, so those
  two fire off the fold instead. It is awaited at the interpret boundary, it is not re-fired on
  resume for an outcome already folded, and a throw is contained and warned like `onEvent`'s.
  `ToolErrorContext` is its second argument — the `callId` and the tool `name` the model asked
  for.

`AgentVerbs.toolErr` now takes `string | ToolFailure`: a bare `reason` still settles an untagged
failure exactly as it did, and a whole `ToolFailure` keeps the tag through the fold.

Router-minted and ladder-minted failures carry their tag the same way, and `kind` / `reason` are
written last, so a payload field of either name can never shadow the discriminant or the model's
channel. Code that
reads `outcome.reason` or discriminates on `outcome.kind` is unaffected.
