# @demlik/tea — all modules

The complete export catalog — all 14 public subpaths. Curated
modules link to their dedicated reference page; the rest are plumbing,
discoverable here with a one-line gloss from their source barrel.

| Subpath | Summary |
| --- | --- |
| [`.`](./tea.md) | TEA-faithful state machine substrate. |
| [`./agent`](./agent.md) | THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools. |
| [`./devtools`](./devtools.md) | presentational inspector for any tea machine. |
| `./devtools/styles.css` |  |
| [`./do`](./do.md) | Durable Object adapter for `@demlik/tea`. |
| [`./extension`](./extension.md) | Chrome service-worker host adapter for @demlik/tea. |
| `./machine-viz` | turn a `Machine` into a Mermaid diagram string. |
| [`./mem`](./mem.md) | in-memory `Store<S>` adapter for `@demlik/tea`. |
| [`./node`](./node.md) | Node host adapter for `@demlik/tea`. |
| `./parity` | the record → replay → normalized-diff go/no-go gate. |
| [`./pbt`](./pbt.md) | Property-based testing primitives for `@demlik/tea` machines. |
| [`./react`](./react.md) | React host adapter for `@demlik/tea`. |
| [`./retry-backoff`](./retry-backoff.md) | exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over. |
| [`./testing`](./testing.md) | test-side ergonomics over @demlik/tea's pure substrate. |
