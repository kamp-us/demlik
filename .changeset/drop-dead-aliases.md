---
"@demlik/tea": minor
---

**Breaking:** two dead `@deprecated` aliases are removed outright (ADR 0016).

- `diff` under `./parity` — use `parityEqual`. Same function, the
  non-inverted name: it returns `true` when the two values are equal.
- `ContextFree` under `./pure` and the root — use `NoCtx`. Same type, the
  one name for the context-free-ctx marker.

Neither had an in-tree use; both existed only to wait out a minor.
