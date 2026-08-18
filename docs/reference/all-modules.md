# @demlik/tea — all modules

The complete export catalog — all 57 public subpaths. Curated
modules link to their dedicated reference page; the rest are plumbing,
discoverable here with a one-line gloss from their source barrel.

| Subpath | Summary |
| --- | --- |
| [`.`](./tea.md) | TEA-faithful state machine substrate. |
| [`./agent`](./agent.md) | THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools. |
| `./authed-call` | resilient-call with one extra dimension: a bearer credential that must be minted before a call goes out and re-minted when the server says it is no longer good (a 401). |
| `./await-terminal` | run a ONE-SHOT / decision-procedure machine to a terminal state and hand the caller a `Promise<State>` that resolves the moment the machine FIRST enters a terminal state. |
| `./batch-window` | coalesce a stream of items into size- or time-bounded BATCHES, then flush each batch as a single Cmd. |
| `./cache` | a TTL cache as pure state, PLUS a periodic eviction Sub. |
| `./chart` | chart — the machine as a DRAWING the compiler reads, not a picture drawn beside one. |
| [`./circuit-breaker`](./circuit-breaker.md) | per-target failure tracking as pure state + ops. |
| `./deadline` | a one-shot Sub that fires when an ABSOLUTE wall-clock deadline is reached. |
| `./debounce` | a timer-based call transformer that coalesces a burst of calls into a single fire. |
| [`./devtools`](./devtools.md) | presentational inspector for any tea machine. |
| `./devtools/styles.css` |  |
| [`./do`](./do.md) | Durable Object adapter for `@demlik/tea`. |
| [`./extension`](./extension.md) | Chrome service-worker host adapter for @demlik/tea. |
| `./extension/react` | React adapters for the background TEA runtime. |
| `./extension/subs` |  |
| `./extension/test-utils` | In-memory `chrome.*` mock for tests in this package and any downstream consumer that wants to test against `chromeStorageStore` behavior without a real chrome environment. |
| `./fan-out` | scatter-gather over a bounded-concurrency work list. |
| `./idempotency` | dedupe-by-key + last-result cache as pure state + ops. |
| `./idempotency/adapter` | the verb seam over the pure idempotency ops. |
| `./idempotent-intake` | receive-once intake for webhooks / queue messages: dedupe by key, enqueue the new ones, replay the cached result to the duplicates. |
| [`./llm-call`](./llm-call.md) | `resilient-call` + structured-output parse + a typed failure variant, around a purpose-discriminated LLM invocation. |
| `./machine-viz` | turn a `Machine` into a Mermaid diagram string. |
| [`./mem`](./mem.md) | in-memory `Store<S>` adapter for `@demlik/tea`. |
| `./monitored-run` | a long-running operation that is BOTH staged and watched: an ordered stage pipeline whose POSITION survives eviction, wrapped by a no-progress safety deadline and (optionally) a periodic durable checkpoint. |
| [`./node`](./node.md) | Node host adapter for `@demlik/tea`. |
| `./paginated-walk` | traverse a paginated API / sitemap end to end WITHOUT a fake clock, without 429s, and resumable across a Durable-Object eviction. |
| `./paginator` | the cursor/offset/page-token walk loop as pure state + ops. |
| `./parity` | the record → replay → normalized-diff go/no-go gate. |
| [`./pbt`](./pbt.md) | Property-based testing primitives for `@demlik/tea` machines. |
| `./pbt/arbitraries` |  |
| `./pbt/runners` |  |
| `./poller` | "poll a source every N ms until a predicate holds, with backoff on failure" as a TEA knob: one config object + a few pre-wired hooks you spread into your machine. |
| `./prediction` | the client-prediction ack primitive (epic #186, facet 2). |
| `./pure` | `@demlik/tea/pure` — THE client-safe entrypoint (ADR 0006, #213). |
| `./rate-limit` | two rate limiters as pure state + ops. |
| [`./react`](./react.md) | React host adapter for `@demlik/tea`. |
| `./reconciler` | the desired-vs-actual sync loop (the "fleet-sync / coverage-gap" shape): walk the ACTUAL world end to end, diff it against the DESIRED spec, then apply each resulting `Change` one at a time until the two agree. |
| `./recorder` | A recorded run, sufficient to reproduce it via `../trace-replay`. |
| `./resilient-call` | @deprecated `call` is deprecated in favor of `@demlik/tea/with-resilience` — the higher-order `withResilience(base, config)` wrapper (TEA-idiomatic: it wraps any existing machine instead of forcing a bespoke embedded slice; epic consolidation verdict, survivor `with-resilience`). |
| [`./retry-backoff`](./retry-backoff.md) | exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over. |
| `./retry-to-success` | run a fallible async port through BOUNDED retry + exponential backoff to success-or-terminal-give-up, and hand the caller a `Promise<R>` that resolves on the first success or REJECTS with a checkable {@link RetryExhaustedError} the moment the retry bound is hit. |
| [`./saga`](./saga.md) | a forward-then-compensate transaction over an ordered list of reversible steps. |
| `./snapshot` | periodic state checkpoint to a host store (R2/KV-shaped). |
| [`./subs`](./subs.md) | universal Sub factories. |
| [`./testing`](./testing.md) | test-side ergonomics over @demlik/tea's pure substrate. |
| `./throttle` | a timer-based call transformer that caps invocation to at most once per `ms` window. |
| `./throttled-input` | gate a high-frequency input stream into a SETTLED, RATE-CAPPED, optionally DEDUPED sequence of emits, as a TEA knob: one config object + a few pre-wired hooks you spread into your machine. |
| `./token-refresh` | a credential's lifecycle as pure state + verbs, with the actual token fetch deferred to a single injected port. |
| `./trace-replay` | The outcome of {@link replayTrace}. |
| `./with-deadline` | auto-fail a wrapped machine at T+N, re-arm on progress. |
| [`./with-resilience`](./with-resilience.md) | the INTERCEPTING wrapper of the wrapper tier. |
| `./with-telemetry` | the pattern-setting wrapper of the wrapper tier. |
| [`./work-queue`](./work-queue.md) | substrate-agnostic work-queue lifecycle on `Store<S>`. |
| `./work-queue/adapter` | the verb seam over the pure queue ops. |
| `./work-queue/ops` | Pure queue-lifecycle ops over `QueueItem<I>[]` — the BLESSED delegation surface for this package. |
| [`./workflow`](./workflow.md) | the durable-workflow runtime core (#124, the first Phase-1 slice of the Temporal-style durable-workflow engine, epic #118). |
