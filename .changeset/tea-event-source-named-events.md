---
"@demlik/tea": minor
---

**Breaking (declaration):** `EventSourceFactoryOpts.onMessage` is now optional, and `EventSourceFactoryOpts.onError` is called with a third argument, `readyState`. A host that only passes these options compiles and runs unchanged. Code that calls the options' own callbacks breaks: `opts.onMessage(...)` on a value typed `EventSourceFactoryOpts` no longer compiles without a check that it is present, and a call to `opts.onError(event, sub)` with two arguments no longer compiles. A wrapper that forwards to such options must check `onMessage` and pass the third argument through.

**Additive (declaration only):** `fromEventSource` receives named server-sent events and tells a closed source from a reconnecting one.

- `events: { types, onEvent }` lists the SSE `event:` names a host receives. One `onEvent` maps each event's `type`, `data` and `lastEventId` to a Msg, or to `null` to drop it. A type the host does not list dispatches nothing.
- `types` refuses the lifecycle names `"open"` and `"error"` (exported as `EventSourceLifecycleType`): in the type when `T` names them, and with a `TypeError` when `fromEventSource` is called with them as a plain `string`. `onOpen` and `onError` receive those events.
- `onError`'s `readyState` (`"connecting" | "open" | "closed"`) lets a host tell a source the browser gave up on from one that is reconnecting, without holding the `EventSource`.
- Cleanup removes every listener the runner added and closes the source. With today's options the runner behaves exactly as before.
- New exports: `ServerSentEvent`, `EventSourceNamedEvents`, `EventSourceReadyState`, `EventSourceLifecycleType`.
