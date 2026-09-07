# Tutorials

Learning-oriented lessons that take you through `@demlik/tea` by building a real machine.

- [Build and replay your first machine](./build-your-first-machine.md) — define a
  Model, a Msg, and a pure `update`; `run` the machine to a terminal state, then
  `replay` the same messages to see tea's determinism firsthand.
- [Build a durable agent](./build-a-durable-agent.md) — declare one `tool`,
  `defineAgent` over a real model, and `agent.run` it on Node with a `fileStore`;
  then kill the process mid-run, run it again, and watch the same run resume
  from its outstanding effect — tools are at-least-once across that crash, so
  the lesson also shows why a handler has to survive running twice.

*Lessons are added as the tutorial quadrant grows.*
