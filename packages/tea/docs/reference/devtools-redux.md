# @demlik/tea/devtools/redux

> watch, export and import a running machine in the Redux DevTools browser extension.

Tier: `experimental`

```ts
import { … } from "@demlik/tea/devtools/redux";
```

## Exports (8)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`connectReduxDevtools`](#connectReduxDevtools) | Function | experimental | Connect a running machine to the Redux DevTools extension. |
| [`DevtoolsBridge`](#DevtoolsBridge) | Interface | experimental | What connectReduxDevtools returns. |
| [`DevtoolsRun`](#DevtoolsRun) | Type | experimental | The part of a run the bridge listens to — the same on both engines. |
| [`MonitorMessage`](#MonitorMessage) | Interface | experimental | A message the panel sends to the page. |
| [`parseDevtoolsExport`](#parseDevtoolsExport) | Function | experimental | Read a session file the panel's Export button saved into a Trace, ready for `replayTrace`. |
| [`ReduxDevtoolsConnection`](#ReduxDevtoolsConnection) | Interface | experimental | One connected instance in the panel, as `connect()` returns it. |
| [`ReduxDevtoolsExtension`](#ReduxDevtoolsExtension) | Interface | experimental | The part of `window.__REDUX_DEVTOOLS_EXTENSION__` the bridge calls. |
| [`ReduxDevtoolsOptions`](#ReduxDevtoolsOptions) | Interface | experimental | Options for connectReduxDevtools. |

## Declarations

<a id="connectReduxDevtools"></a>

### `connectReduxDevtools`

```ts
function connectReduxDevtools<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  run: DevtoolsRun<S, M>,
  opts?: ReduxDevtoolsOptions<M>,
): DevtoolsBridge
```

<a id="DevtoolsBridge"></a>

### `DevtoolsBridge`

```ts
interface DevtoolsBridge {
  /** `false` when no extension was found; the bridge then does nothing. */
  readonly connected: boolean;
  /** Stop listening to the run and to the panel. Idempotent. */
  disconnect(): void;
}
```

<a id="DevtoolsRun"></a>

### `DevtoolsRun`

```ts
type DevtoolsRun<S, M extends { type: string }> = Pick<RunHandle<S, M>, "observe" | "onBoot">
```

<a id="MonitorMessage"></a>

### `MonitorMessage`

```ts
interface MonitorMessage {
  readonly payload?: unknown;
  readonly type: string;
}
```

<a id="parseDevtoolsExport"></a>

### `parseDevtoolsExport`

```ts
function parseDevtoolsExport<S, M>(json: string): Trace<S, M>
```

<a id="ReduxDevtoolsConnection"></a>

### `ReduxDevtoolsConnection`

```ts
interface ReduxDevtoolsConnection {
  error(message: string): void;
  init(state: unknown): void;
  send(action: { readonly type: string } | null, state: unknown): void;
  subscribe(listener: (message: MonitorMessage) => void): (() => void) | undefined;
  unsubscribe(): void;
}
```

<a id="ReduxDevtoolsExtension"></a>

### `ReduxDevtoolsExtension`

```ts
interface ReduxDevtoolsExtension {
  connect(options: Record<string, unknown>): ReduxDevtoolsConnection;
}
```

<a id="ReduxDevtoolsOptions"></a>

### `ReduxDevtoolsOptions`

```ts
interface ReduxDevtoolsOptions<M> {
  /**
   * Enables the panel's Dispatch button: a Msg typed there is checked against
   * the current state's accepted Msgs, then handed to this function. The
   * Promise engine's `runtime.dispatch` fits as it is. On the Effect engine,
   * pass a function that runs the handle's `dispatch` Effect. Omitted, the
   * Dispatch button is off.
   */
  readonly dispatch?: (msg: M) => Promise<unknown>;
  /**
   * The extension to connect to. Default
   * `globalThis.__REDUX_DEVTOOLS_EXTENSION__`.
   */
  readonly extension?: ReduxDevtoolsExtension;
  /** How many actions the panel keeps. Default `500`. */
  readonly maxAge?: number;
  /** The instance name in the panel's instance picker. Default `"tea"`. */
  readonly name?: string;
}
```
