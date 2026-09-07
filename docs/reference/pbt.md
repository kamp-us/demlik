# @demlik/tea/pbt

> Property-based testing primitives for `@demlik/tea` machines.

```ts
import { … } from "@demlik/tea/pbt";
```

## Exports (13)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `arbConstantMsg` | Function | Build a payload-free Msg variant arbitrary. |
| `arbGuidedSequence` | Function | State-aware Msg sequence arbitrary — generates only msgs whose precondition holds in the current state. |
| `arbMsg` | Function | Build a single `fc.Arbitrary<M>` from a `MsgArbitraryTable<M>`. |
| `arbMsgSequence` | Function | Build an arbitrary of Msg sequences over a per-Msg arbitrary. |
| `arbRecordMsg` | Function | Build a record-shaped Msg variant arbitrary. |
| `foldEvents` | Function | Fold a Msg sequence through a machine's pure reducer, returning the per-step trace, every state in order, and the final state. |
| `MsgArbitraryTable` | Type | Strict per-variant Msg arbitrary table. |
| `msgTypeKeys` | Function | Extract the Msg discriminant set at runtime from a machine. |
| `propertyInvariant` | Function | Assert a predicate holds on EVERY transition step in a generated sequence. |
| `propertyTerminates` | Function | Assert every generated Msg sequence ends in a terminal state. |
| `propertyTrace` | Function | Assert a predicate over the full trace plus the final state. |
| `Step` | Interface | One unit in a fold trace — the four pieces of data a property invariant typically asserts on. |
| `stubCtxThrowingProxy` | Function | Build a Ctx value whose every property access throws. |
