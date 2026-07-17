# @demlik/tea/testing

> test-side ergonomics over @demlik/tea's pure substrate.

```ts
import { … } from "@demlik/tea/testing";
```

## Exports (16)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `assertWrapperFaithful` | Function |  |
| `AssertWrapperFaithfulOpts` | Interface | Options for the conformance replay. |
| `bindMachine` | Function |  |
| `BoundMachine` | Interface | The bound testing surface. |
| `expectActiveSubs` | Function |  |
| `expectCmdEmitted` | Function |  |
| `expectCmdSequence` | Function |  |
| `expectFinalState` | Function |  |
| `InterceptingOpt` | Interface | Configures the intercepting relaxation (see `AssertWrapperFaithfulOpts.intercepting`). |
| `noopRuntime` | Function |  |
| `ReplayOpts` | Interface | Shared options shape for every test assertion below. |
| `stateFactory` | Function |  |
| `StateFactoryAPI` | Type | The API returned by `stateFactory`. |
| `StateFactoryDefaults` | Type | Defaults shape passed to `stateFactory`. |
| `step` | Function |  |
| `WrapperModel` | Type | The composed Model shape every `withX` wrapper produces: the base machine's state nested under `base`, and the wrapper's own NAMED, serializable slice under a single `$`-prefixed key. |
