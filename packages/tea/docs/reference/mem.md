# @demlik/tea/mem

> in-memory `Store<S>` adapter for `@demlik/tea`.

Tier: `stable`

```ts
import { … } from "@demlik/tea/mem";
```

## Exports (2)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`memoryStore`](#memoryStore) | Function | stable | Build an in-memory `Store<S>`. |
| [`MemoryStoreOptions`](#MemoryStoreOptions) | Interface | stable | Options for memoryStore. |

## Declarations

<a id="memoryStore"></a>

### `memoryStore`

```ts
function memoryStore<S>(
  initial?: S | null,
  parse?: (raw: unknown) => Migrated<S>,
): DeletableStore<S>
function memoryStore<S>(
  initial: S | null | undefined,
  parse: ((raw: unknown) => Migrated<S>) | undefined,
  options: MemoryStoreOptions & { readonly fenced: true },
): FencedStore<S> & DeletableStore<S>
function memoryStore<S>(
  initial?: S | null,
  parse?: (raw: unknown) => Migrated<S>,
  options?: MemoryStoreOptions,
): DeletableStore<S> | FencedStore<S> & DeletableStore<S>
```

<a id="MemoryStoreOptions"></a>

### `MemoryStoreOptions`

```ts
interface MemoryStoreOptions {
  readonly fenced?: true;
}
```
