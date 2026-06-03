# Pattern 08 — The TypeScript Tax

What TEA costs in TypeScript that it doesn't cost in Elm.

## The tax sheet

| Elm gives you for free | In TS you must... |
|----------------------|-------------------|
| Exhaustive `case` matching | Write `switch` + `default: assertNever(msg)` or use a mapped record type |
| Immutable records by default | Discipline: never mutate, use spread `{...state, field: val}` |
| Opaque `Cmd msg` type | Define a discriminated union `{ type: string; ... }` |
| Managed Sub lifecycle (diffing) | Build the diffing yourself — track sub ids, call cleanup on removal |
| No null / undefined | `strictNullChecks`, but null still leaks through |
| Closed universe (no FFI) | Discipline: don't escape the machine. The interpret function is the only escape hatch |
| Compiler-enforced Msg completeness | `assertNever` in default branches, or mapped record types that reject missing keys |

## Five additional pieces you must build yourself

### 1. The runtime loop

Elm's runtime is invisible — it ships with the language. In TS, you need a
`runtime(program)` function that boots the machine, connects the interpreter,
and manages the dispatch loop. raj does this in 34 lines. Any TS TEA
implementation needs this as its core.

### 2. The Store adapter

Elm starts fresh on every page load. In TS, you often need persistence
(Durable Objects, chrome.storage, localStorage). You need a `Store` interface:

```typescript
interface Store<S> {
  load(): Promise<unknown>   // raw data from storage
  save(state: S): Promise<void>
  migrate(raw: unknown): S | null  // boundary parse
}
```

`load()` returns `unknown` because storage doesn't know your type.
`migrate()` is the boundary parse — returns `S` on recognized shape,
`null` on unrecognized (boots fresh). Must not throw.

### 3. The Sub identity system

Elm's runtime diffs subs by internal identity. TS has no equivalent — you need
an explicit id on each Sub so the runtime knows "this is the same subscription,
keep it alive" vs "this is new, start it."

```typescript
type Sub = { type: string; id: string }
```

The id must be deterministic — `Math.random()` as an id means the sub restarts
on every state change.

### 4. The testing layer

Elm's `update` is testable by default — call it with state and msg, assert on
the output. In TS, you need a `replay()` function that threads init + multiple
msgs through update without booting a runtime or calling the interpreter.

```typescript
function replay(program, msgs) {
  let [state, cmds] = program.init()
  const allCmds = [...cmds]
  for (const msg of msgs) {
    const [next, newCmds] = program.update(msg, state)
    state = next
    allCmds.push(...newCmds)
  }
  return { state, cmds: allCmds }
}
```

### 5. Cross-runtime communication

Elm has Ports for JS interop. In a TS system with multiple machines running
in different contexts (browser + worker + extension), you need typed channels
between runtimes.

## The TS-TEA build checklist

Before shipping a new TEA machine in TypeScript, verify:

- [ ] Every Msg variant handled in update (exhaustive match or mapped record)
- [ ] Every Cmd type has an interpret handler
- [ ] Every Sub type has a subscribe handler with cleanup function
- [ ] Every Sub id is deterministic and unique
- [ ] State is not mutated — spread creates new objects
- [ ] No `await` / `Promise` / `setTimeout` inside update
- [ ] Effects are data objects, not closures or class instances
- [ ] Tests use replay — never boot a runtime in unit tests
- [ ] Store adapter handles `migrate()` for schema evolution
- [ ] Boundary data is parsed, not cast (`as S` is forbidden)
