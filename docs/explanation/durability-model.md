# What durability actually promises

A machine built with `@demlik/tea` can be killed mid-run and picked up again by
a different process — or a different machine in a different datacentre — with no
recovery code of your own. This page says exactly how far that goes, and where it
stops, because the edge is the part that matters when you are deciding whether to
trust it.

## The mechanism, in one paragraph

Your Model is plain JSON. A transition is a pure function from `(Model, Msg)` to
a new Model plus a list of effects to run. Hand the runtime a `Store` and it
**saves the new Model before it runs that transition's effects**. So the saved
state is always one step ahead of the outside world: whatever is on disk either
already knows about an effect, or is about to ask for it. On boot the runtime
reads the Store, sees which effects the Model is still waiting on, and re-issues
them. The reducer never learns it was interrupted.

That is the whole story. There is no recovery API, no journal you replay by
hand, no lifecycle hook. Persistence is a round trip of a JSON value.

## What is guaranteed

- **State is durable.** Every transition that completed is on disk before the
  next effect runs. Restarting resumes the same run — the same run id, the same
  accumulated Model — rather than starting a new one.
- **The Model is idempotent under re-fire.** Re-issuing an outstanding effect
  and folding its result cannot corrupt state. Folding the same settle twice
  leaves the same Model.
- **A finished run stays finished.** Boot a Store holding a completed Model and
  you get that Model back; it does not re-run.
- **Nothing is hidden from you.** The saved state is a JSON file — or a Durable
  Object storage key, or a `chrome.storage` entry — that you can print, diff, and
  assert on. There is no opaque runtime handle in the way.

## What is not guaranteed: effects are at-least-once

**A side effect can run more than once across a crash.** This is the single most
important sentence on the page.

The window is between two moments:

1. your handler performs its side effect — writes the row, sends the email,
   calls the API;
2. the runtime writes that effect's settle into the Store.

A crash inside that window leaves a Model that is still waiting on the effect. On
boot the runtime re-issues it, and your handler runs the effect a second time.
The state fold is idempotent; the effect in the world is not, because the library
has no way to know what your handler did out there.

This is the same guarantee every durable-execution system ships. Exactly-once
delivery of a real-world side effect is not a thing any of them provide; what
they provide is at-least-once with a named window, and here it is named.

## What you do about it

**Make handlers idempotent, or key them.**

- **Idempotent by construction** is the cheapest fix when it is available:
  writing a file at a fixed path, `PUT`ing a record by id, upserting a row. Doing
  it twice leaves the same result.
- **Key the effect** when it is not. Every tool call and effect carries a stable
  id that is the same across the re-fire — for an agent's tool calls that is
  `callId`. Pass it to the downstream system as its idempotency key, or record it
  yourself and skip an id you have already handled. The dedupe lives in your
  handler; the library ships the stable id, not the deduplication.
- **Push the risk to the end.** Where an effect is genuinely non-repeatable and
  cannot be keyed — charging a card through an API with no idempotency key —
  order it so the unrepeatable step is the last thing that happens before a
  settle, and keep the window as small as you can.

A useful habit when testing: kill the process at several different points, not
just one, and check that the result is the same. A single well-timed `Ctrl-C`
that lands outside the window proves less than it looks like it does.

## What a finished agent run keeps

For the agent layer specifically, one detail surprises people. When a run reaches
`phase: "done"`, the stored Model holds the **run slice and the final `output`** —
and `conversation` is cleared to `null`.

This is deliberate, not a bug. The terminating turn is stamped onto `output`
before the conversation is dropped, so the answer survives; what does not survive
is the full transcript, which would otherwise grow without bound in storage that
is being kept for its state, not its history. If you need the transcript after a
run ends, capture it as it goes rather than expecting to read it back off the
finished Model.

## Further reading

- [Make a machine durable and crash-recoverable](../how-to/make-durable.md) — the
  `Store` seam and the four host factories, as a task.
- [Build a durable agent](../tutorial/build-a-durable-agent.md) — the same story
  as a lesson, including a kill-it-and-rerun exercise.
- [Deploy an agent to a Durable Object](../how-to/deploy-an-agent-to-a-durable-object.md)
  — where the eviction is the platform's rather than your `Ctrl-C`.
- [Why failures are values and bugs are throws](./errors-as-data.md) — why the
  Model has to be JSON, which is what makes all of the above possible.
