# Tutorials

Learning-oriented lessons that take you through `@demlik/tea` by building a real machine.

- [Build and replay your first machine](./build-your-first-machine.md) — define a
  Model, a Msg, and a pure `update`; `run` the machine to a terminal state, then
  `replay` the same messages to see tea's determinism firsthand.
- [Build a machine from a chart](./build-a-machine-from-a-chart.md) — write one
  `defineChart` value, derive the State/Msg/Cmd unions and the `update` table
  from it with `compile`, and watch the compiler refuse a machine that forgot to
  decide something.

*Lessons are added as the tutorial quadrant grows.*
