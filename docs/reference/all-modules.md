# @demlik/tea — all modules

The complete export catalog — all 21 public subpaths. Curated
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
| `./extension/react` | React adapters for the background TEA runtime. |
| `./extension/subs` |  |
| `./extension/test-utils` | In-memory `chrome.*` mock for tests in this package and any downstream consumer that wants to test against `chromeStorageStore` behavior without a real chrome environment. |
| `./machine-viz` | turn a `Machine` into a Mermaid diagram string. |
| [`./mem`](./mem.md) | in-memory `Store<S>` adapter for `@demlik/tea`. |
| [`./node`](./node.md) | Node host adapter for `@demlik/tea`. |
| `./parity` | the record → replay → normalized-diff go/no-go gate. |
| [`./pbt`](./pbt.md) | Property-based testing primitives for `@demlik/tea` machines. |
| `./pbt/arbitraries` |  |
| `./pbt/runners` |  |
| `./pure` | `@demlik/tea/pure` — THE client-safe entrypoint (ADR 0006, #213). |
| [`./react`](./react.md) | React host adapter for `@demlik/tea`. |
| [`./retry-backoff`](./retry-backoff.md) | exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over. |
| [`./subs`](./subs.md) | universal Sub factories. |
| [`./testing`](./testing.md) | test-side ergonomics over @demlik/tea's pure substrate. |
