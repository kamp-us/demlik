# Stop a running agent

Create a `runtime::DriveSignal`, pass a clone through `DefinedAgentRunOptions::signal`, and retain the original handle for the stop action:

```rust,ignore
let signal = DriveSignal::new();
let running = agent.run("Find the answer", options.signal(signal.clone()));
signal.abort();
let state = running.await?;
```

The run resolves with a durable cancelled state. A preaborted signal skips the first model call and leaves `runId` null. An already terminal stored state wins over cancellation, and a fresh signal does not restart it. Omitting the signal keeps the previous behavior. The store builder carries the signal across its error-type change. Existing constructor callers keep compiling; direct `DefinedAgentRunOptions` struct literals must now provide `signal` (usually `None`).

Cancellation uses the existing dispatch tail. In the frozen TypeScript implementation, abort requests cancellation; a held provider or tool must finish before the queued cancellation can fold. A bare failure hook may run in that interval. Queued settle messages then save unchanged cancelled states, without projecting late tool events or advancing the conversation. This measured ordering is narrower than the Source option documentation's statement about in-flight work and teardown. The fixture preserves every save string, including those unchanged saves.

Streaming callbacks retain their original sink and can still deliver after cancellation or run resolution. The signal is not passed into tool handlers and does not cancel their operations. The example verifies retained-state resume in process; it does not supply a decoder for cold Store replay. `Agent.run` remains native-only; Wasm checks cover compilation of the portable machine and option types.
