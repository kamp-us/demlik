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
and the acquisition order they produce are unchanged, and a graph built through them needs no edit.

**What breaks: an explicit `Provider` ANNOTATION.** `K` defaults to `string`, so `readonly
string[]` no longer fits the `readonly (keyof M)[]` the map wants — including a leaf provider whose
`deps` is `[]`, because the annotation's default is what is compared, not the value:

```ts
// Was: compiled. Now: TS2322 — `string` is not assignable to `"config" | "db"`.
const config: Provider<Config> = { deps: [], acquire: () => ({ url: "postgres://x" }) };
const db: Provider<string, { config: Config }> = { deps: ["config"], acquire: (d) => connect(d.config.url) };

// Fix, either: name the key set…
const db: Provider<string, { config: Config }, "config" | "db"> = { … };
// …or drop the annotation and let the constructors infer it (preferred).
const db = layer(["config"], (d: { config: Config }) => connect(d.config.url));
```
