---
"@demlik/tea": minor
---

**Breaking: a run on a fenced store must now be given an `onError`, or it does not compile.** Losing a fence is routine for a host that moves runs between processes, and with no `onError` the default sink rethrew the conflict and ended the process, along with every other run in it. ADR 0031 records the owner's ruling.

The rule is the new `StoreAndOnError<S>` type, and it holds on `run` (both engines), `RunOptions`, `useMachine`, `createAgentHost`, a defined agent's `run`, and `agentTool`. To migrate, pass a sink beside the store:

```ts
run(machine, {
  store: fileStore(path, parse, { fenced: true }),
  onError: (error, { phase }) => console.error(phase, error),
});
```

`useMachine`, `createAgentHost`, a defined agent's `run` and `agentTool` now take an `onError` too, because they had no way to pass one. `useMachine` reads the latest render's, so a sink passed inline does not replace the run. `AgentHostConfig` is now a type alias rather than an interface, so nothing can `extends` it; `AgentHostWiring` is the new interface for everything but the store and its sink.

`doStore` called with options whose `fenced` is known only at runtime, such as a value typed `DoStoreOptions` or `DoStoreOptions | undefined`, now returns a store that may be fenced, as `fileStore` and `memoryStore` already do, so a run on it needs an `onError` too. The Promise engine's `run` options now have a name, the exported `PromiseRunOptions`, where the reference prints them.

The type reads a store's declared type, so a fenced store assigned to a variable typed plain `Store<S>` still compiles with no `onError` and runs on the default sink.

The default sink does not change. A failing Sub on an unfenced run with no `onError` still ends the process.
