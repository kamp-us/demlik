# @demlik/tea/subs

> universal Sub factories.

```ts
import { … } from "@demlik/tea/subs";
```

## Exports (29)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `CancelTimer` | Type | Cancels a scheduled reconnect timer (the inverse of `schedule`). |
| `CombinedManagedResources` | Interface | What `combineManagedResources` returns: the single managed-resource `subscribe` cell for the machine's `subscribe` record, and a `subs(state)` builder for `subscriptions(state)`. |
| `combineManagedResources` | Function |  |
| `defineListener` | Function |  |
| `defineManagedResource` | Function |  |
| `DefineManagedResourceOpts` | Interface |  |
| `EventSourceFactoryOpts` | Interface |  |
| `fromBroadcastChannel` | Function |  |
| `fromEventSource` | Function |  |
| `fromEventTarget` | Function |  |
| `fromInterval` | Function |  |
| `fromPort` | Function |  |
| `fromReconnectingWebSocket` | Function |  |
| `fromTimeout` | Function |  |
| `fromTransport` | Function |  |
| `FromTransportOpts` | Interface |  |
| `fromWebSocket` | Function |  |
| `GatedManagedResource` | Interface | A battery paired with a state-gate. |
| `ListenerTarget` | Interface | The imperative listener target, expressed as the `add`/`remove` pair the substrate pairs into a reconciled resource. |
| `ManagedResourceBattery` | Interface | What the battery returns: a `.sub(key)` builder for `subscriptions`, the `.subscribe` handler for the machine's `subscribe` record, a `.get(key)` accessor so Cmd handlers can reach the live Handle while the resource is held, and a `.subIdFor(key)` for tests. |
| `ManagedResourceSub` | Interface | The Sub the battery builds. |
| `ReconnectingWebSocketFactoryOpts` | Interface |  |
| `SubscribeHandler` | Type |  |
| `Transport` | Interface | Duplex transport. |
| `TransportBattery` | Interface | What the battery returns: a Sub builder (for `subscriptions`), the Sub's `subscribe` handler (for `subscribe.transport`), and a `send(key, outbound)` helper the consumer's Cmd handler calls. |
| `TransportFactory` | Type | Factory the consumer wires to a platform-specific transport. |
| `TransportSub` | Interface | The Sub the battery builds. |
| `WebSocketFactoryOpts` | Interface |  |
| `WebSocketSubData` | Type |  |
