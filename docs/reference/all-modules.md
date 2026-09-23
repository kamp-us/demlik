# @demlik/tea — all modules

The complete export catalog — all 24 public subpaths. Curated
modules link to their dedicated reference page; the rest are plumbing,
discoverable here with a one-line gloss from their source barrel.

| Subpath | Summary |
| --- | --- |
| [`.`](./tea.md) | TEA-faithful state machine substrate. |
| [`./agent`](./agent.md) | THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools. |
| [`./devtools`](./devtools.md) | presentational inspector for any tea machine. |
| `./devtools/styles.css` |  |
| [`./do`](./do.md) | Durable Object adapter for `@demlik/tea`. |
| `./effect` | the Effect engine: `run` boots a machine with Effect handlers and sub runners, the caller's Layers and interruption on stop, and yields the same run handle the Promise engine returns. |
| [`./extension`](./extension.md) | Chrome service-worker host adapter for @demlik/tea. |
| [`./flow`](./flow.md) | the multi-step control-flow batteries: fan a batch out, run steps in order and compensate on failure, poll until a predicate holds, reconcile desired against actual. |
| [`./idempotency`](./idempotency.md) | do-it-once: dedupe by key, cache the result, and replay that result to every duplicate arrival. |
| [`./jev`](./jev.md) | ask TypeSafe **Jev** (System One) a map of typed questions and get a typed answer back under each name: the wire contract, the one Cmd that issues the call, and the batching composition over it. |
| `./machine-viz` | turn a `Machine` into a Mermaid diagram string. |
| [`./mem`](./mem.md) | in-memory `Store<S>` adapter for `@demlik/tea`. |
| [`./node`](./node.md) | Node host adapter for `@demlik/tea`. |
| [`./paginate`](./paginate.md) | the pagination batteries: the cursor walk as pure state, and the resumable end-to-end traversal built over it. |
| `./parity` | the record → replay → normalized-diff go/no-go gate. |
| [`./pbt`](./pbt.md) | Property-based testing primitives for `@demlik/tea` machines. |
| [`./persistence`](./persistence.md) | the durability batteries: record a run to a trace, replay that trace back, and checkpoint a long-running machine to a host store between evictions. |
| [`./promise`](./promise.md) | the Promise engine: `run` boots a machine and drives its serial dispatch loop on Promises, and `driveToDone` runs one to its terminal state. |
| [`./react`](./react.md) | React host adapter for `@demlik/tea`. |
| [`./resilience`](./resilience.md) | the call-hardening batteries: deadlines, retries, circuit breakers, rate limits, TTL caches, credential refresh, and the wrappers that bolt them onto a machine you already have. |
| [`./retry-backoff`](./retry-backoff.md) | exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over. |
| [`./testing`](./testing.md) | test-side ergonomics over @demlik/tea's pure substrate. |
| [`./timing`](./timing.md) | the call-rate batteries: coalesce a burst into one fire, cap a stream to one fire per window, and gate a high-frequency input into a settled, rate-capped, optionally deduped sequence of emits. |
| [`./work-queue`](./work-queue.md) | a substrate-agnostic work-queue lifecycle over `Store<S>`: enqueue, claim the next item, mark it done, failed or cancelled, and reset whatever was running when the process went away. |
