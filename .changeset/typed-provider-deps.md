---
"@demlik/tea": minor
---

`provide`: a misspelled dependency is now a compile error, not a boot-time throw.

`Provider` gains a third type parameter — the dependency NAME set — and `provide` binds it to
`keyof M`. Following Effect's `Layer<ROut, E, RIn>`, where requirements are a type parameter and a
graph that does not satisfy them is refused by the compiler:

```ts
provide({
  config: value({ url: "postgres://x" }),
  // Was: compiled, then threw `UnknownProviderError` at `open()`.
  // Now:  does not compile — "confg" is not a key of this map.
  db: layer(["confg"], (deps: { config: Config }) => connect(deps.config.url)),
});
```

`UnknownProviderError` stays, for the untyped path only — a cast map, one assembled at runtime,
one read back through an erased `Provider<unknown, …>` — where there is no key set to check
against.

Minor rather than patch because the tightening rejects code that used to compile. `layer`, `value`
and the acquisition order they produce are unchanged; a hand-written `Provider<T, D>` still names
its deps with plain `string`, and only the map it is passed to narrows them.
