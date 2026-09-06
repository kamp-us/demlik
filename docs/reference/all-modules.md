# @demlik/tea — all modules

The complete export catalog — all 44 public subpaths. Curated
modules link to their dedicated reference page; the rest are plumbing,
discoverable here with a one-line gloss from their source barrel.

| Subpath | Summary |
| --- | --- |
| [`.`](./tea.md) | TEA-faithful state machine substrate. |
| [`./agent`](./agent.md) | THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools. |
| `./await-terminal` | run a ONE-SHOT / decision-procedure machine to a terminal state and hand the caller a `Promise<State>` that resolves the moment the machine FIRST enters a terminal state. |
| `./batch-window` | coalesce a stream of items into size- or time-bounded BATCHES, then flush each batch as a single Cmd. |
| `./chart` | chart — the machine as a DRAWING the compiler reads, not a picture drawn beside one. |
| `./chart/inspect` | the chart, as a debugger reads it — headless, framework-free, pure. |
| `./chart/inspect/react` | the chart inspector, as one component. |
| `./chart/inspect/styles.css` |  |
| `./chart/lane` | chart/lane — N chart instances in parallel, grouped into phases that sequence. |
| `./chart/lane/react` | a lane, as one page. |
| `./chart/lane/server` | One lane, as the two files a host already has on disk. |
| `./chart/lane/styles.css` |  |
| `./chart/report` | chart/report — a fabrika lane, imported as charts and read back as markdown. |
| [`./devtools`](./devtools.md) | presentational inspector for any tea machine. |
| `./devtools/styles.css` |  |
| [`./do`](./do.md) | Durable Object adapter for `@demlik/tea`. |
| [`./extension`](./extension.md) | Chrome service-worker host adapter for @demlik/tea. |
| `./extension/react` | React adapters for the background TEA runtime. |
| `./extension/subs` |  |
| `./extension/test-utils` | In-memory `chrome.*` mock for tests in this package and any downstream consumer that wants to test against `chromeStorageStore` behavior without a real chrome environment. |
| `./fan-out` | scatter-gather over a bounded-concurrency work list. |
| `./journal` | an append-only, ordered record log for `@demlik/tea`. |
| [`./llm-call`](./llm-call.md) | `resilient-call` + structured-output parse + a typed failure variant, around a purpose-discriminated LLM invocation. |
| `./machine-viz` | turn a `Machine` into a Mermaid diagram string. |
| [`./mem`](./mem.md) | in-memory `Store<S>` adapter for `@demlik/tea`. |
| `./monitored-run` | a long-running operation that is BOTH staged and watched: an ordered stage pipeline whose POSITION survives eviction, wrapped by a no-progress safety deadline and (optionally) a periodic durable checkpoint. |
| [`./node`](./node.md) | Node host adapter for `@demlik/tea`. |
| `./parity` | the record → replay → normalized-diff go/no-go gate. |
| [`./pbt`](./pbt.md) | Property-based testing primitives for `@demlik/tea` machines. |
| `./pbt/arbitraries` |  |
| `./pbt/runners` |  |
| `./poller` | "poll a source every N ms until a predicate holds, with backoff on failure" as a TEA knob: one config object + a few pre-wired hooks you spread into your machine. |
| `./prediction` | the client-prediction ack primitive (epic #186, facet 2). |
| `./pure` | `@demlik/tea/pure` — THE client-safe entrypoint (ADR 0006, #213). |
| [`./react`](./react.md) | React host adapter for `@demlik/tea`. |
| `./reconciler` | the desired-vs-actual sync loop (the "fleet-sync / coverage-gap" shape): walk the ACTUAL world end to end, diff it against the DESIRED spec, then apply each resulting `Change` one at a time until the two agree. |
| `./recorder` | A recorded run, sufficient to reproduce it via `../trace-replay`. |
| [`./retry-backoff`](./retry-backoff.md) | exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over. |
| [`./saga`](./saga.md) | a forward-then-compensate transaction over an ordered list of reversible steps. |
| `./snapshot` | periodic state checkpoint to a host store (R2/KV-shaped). |
| [`./subs`](./subs.md) | universal Sub factories. |
| [`./testing`](./testing.md) | test-side ergonomics over @demlik/tea's pure substrate. |
| `./trace-replay` | The outcome of {@link replayTrace}. |
| [`./workflow`](./workflow.md) | the durable-workflow runtime core (#124, the first Phase-1 slice of the Temporal-style durable-workflow engine, epic #118). |
