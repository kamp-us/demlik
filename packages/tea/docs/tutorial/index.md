# Tutorials

Learning-oriented lessons that take you through `@demlik/tea` by building a real machine.
The words the lessons use are each defined in the [glossary](../glossary.md).

- [Build and replay your first machine](./build-your-first-machine.md) — define a
  [Model](../glossary.md#model), a [Msg](../glossary.md#msg), and a pure [`update`](../glossary.md#update);
  [`run`](../glossary.md#run) the machine to a terminal state, then
  [`replay`](../glossary.md#replay) the same messages to see tea's determinism firsthand.
- [Add your first effect](./add-your-first-effect.md) — declare one
  [Cmd](../glossary.md#cmd), return it from `update`, write its
  [handler](../glossary.md#handler), and watch its success Msg and its failure
  Msg arrive; then add a second Cmd and see the two run in order.
- [Build a durable agent](./build-a-durable-agent.md) — declare one [`tool`](../glossary.md#tool),
  `defineAgent` over a real model, and `agent.run` it on Node with a `fileStore`;
  then kill the process mid-run, run it again, and watch the same run resume
  from its outstanding effect — tools are at-least-once across that crash, so
  the lesson also shows why a handler has to survive running twice.

*Lessons are added as the tutorial quadrant grows.*
