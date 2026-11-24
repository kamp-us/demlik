---
"@demlik/tea": minor
---

`fromEventSource` receives named server-sent events and tells a closed source from a reconnecting one.

- `events: { types, onEvent }` lists the SSE `event:` names a host receives; one `onEvent` maps each event's `type`, `data` and `lastEventId` to a Msg, or to `null` to drop it. A type the host does not list dispatches nothing.
- `onError` receives a third argument, `readyState` (`"connecting" | "open" | "closed"`), so a host can tell a source the browser gave up on from one that is reconnecting without holding the `EventSource`.
- `onMessage` is optional, so a host that receives only named events passes no placeholder.
- Cleanup removes every listener the runner added and closes the source. With today's options the runner behaves exactly as before.
- New exports: `ServerSentEvent`, `EventSourceNamedEvents`, `EventSourceReadyState`.
