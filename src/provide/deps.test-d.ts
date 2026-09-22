// Type-level proof that a misspelled dependency is a COMPILE error (#186).
//
// `Provider.deps` used to be `readonly string[]`, so `layer(["confg"], …)`
// compiled and surfaced at `open()` as an `UnknownProviderError` — a good error
// at the wrong time. `provide` now binds each provider's dep names to `keyof M`,
// following Effect's `Layer<ROut, E, RIn>`: requirements are a type parameter,
// and the graph that does not satisfy them is refused by the compiler.
//
// This file is in the `tsconfig.json` program (which excludes only `*.test.ts`),
// so `pnpm typecheck` is what enforces it. Every `@ts-expect-error` below MUST
// sit on a line that genuinely fails to type-check — an unused one is itself an
// error, which is what makes this a test rather than a comment.

import { dep, layer, type Provider, provide, value } from "./index";

type Config = { url: string };

// ── The wiring that is correct still compiles ──────────────────────────────

const good = provide({
  config: value<Config>({ url: "postgres://x" }),
  db: layer(["config"], (deps: { config: Config }) => `db@${deps.config.url}`),
  cache: layer(
    ["config", "db"],
    (deps: { config: Config; db: string }) => `${deps.db}/${deps.config.url}`,
  ),
});

// …and the `ctx` it produces is still keyed by the map, with each value's type.
const ctxIsTyped: Promise<{ config: Config; db: string; cache: string }> = good
  .open()
  .then((scope) => scope.ctx);
void ctxIsTyped;

// ── A dependency that is not a key of the map does not ─────────────────────
//
// Each case below annotates `acquire` with a shape the map DOES satisfy, so the
// only thing wrong is the `deps` list. That isolation is the point: the
// acquire-shape check predates this change and would have caught a case whose
// annotation named the typo too, which would make the test pass for the old
// reason.

provide({
  config: value<Config>({ url: "postgres://x" }),
  // @ts-expect-error `confg` is not a key of this map — the typo is caught here,
  // not at `open()` as an `UnknownProviderError`.
  db: layer(["confg"], (deps: { config: Config }) => `db@${deps.config.url}`),
});

provide({
  config: value<Config>({ url: "postgres://x" }),
  // @ts-expect-error `secrets` is a key of no map — a dependency on a provider
  // that was never declared.
  db: layer(["secrets"], (deps: { config: Config }) => `db@${deps.config.url}`),
});

// One good name beside one bad one is still a compile error: the check is over
// the whole list, not its first entry.
provide({
  config: value<Config>({ url: "postgres://x" }),
  clock: value(() => 42),
  // @ts-expect-error `clck` is not a key of this map.
  db: layer(
    ["config", "clck"],
    (deps: { config: Config }) => `db@${deps.config.url}`,
  ),
});

// ── The type-level check `provide` already made is untouched ───────────────

provide({
  config: value<Config>({ url: "postgres://x" }),
  // @ts-expect-error `config` IS a key, but this `acquire` reads it at a type
  // the map's `config` does not have.
  db: layer(["config"], (deps: { config: number }) => `db@${deps.config}`),
});

// ── A leaf provider is admissible in every map ─────────────────────────────

// `layer(acquire)` and `value(v)` carry no dep names, so binding deps to
// `keyof M` must not make them harder to place.
provide({ clock: value(() => 42) });
provide({ clock: value(() => 42), rng: layer(() => Math.random) });

// ── …but only in its CONSTRUCTED form: an annotation is the migration ──────
//
// The cases above all let `layer`/`value` infer `K` from the literal. Writing
// the type down instead puts `K` back at its `string` default, and `readonly
// string[]` does not fit `readonly (keyof M)[]` — the break the changeset and
// the `Provider` tsdoc describe. These cases are what makes the next change to
// `provide`'s constraint confront it rather than rediscover it.

const annotatedLeaf: Provider<Config> = {
  deps: [],
  acquire: () => ({ url: "postgres://x" }),
};
const annotatedDep: Provider<string, { config: Config }> = {
  deps: ["config"],
  acquire: (deps) => `db@${deps.config.url}`,
};

provide({
  // @ts-expect-error the annotation's `K` is `string`, not this map's keys —
  // and a leaf provider with `deps: []` is caught too, since the default is
  // what is compared rather than the value.
  config: annotatedLeaf,
  // @ts-expect-error same default, on a provider that does name a dependency.
  db: annotatedDep,
});

// The migration: name the key set, and the annotated form fits again.
const migratedLeaf: Provider<Config, Record<never, never>, "config" | "db"> = {
  deps: [],
  acquire: () => ({ url: "postgres://x" }),
};
const migratedDep: Provider<string, { config: Config }, "config" | "db"> = {
  deps: ["config"],
  acquire: (deps) => `db@${deps.config.url}`,
};

provide({ config: migratedLeaf, db: migratedDep });

// ── The token form derives the annotation instead of restating it (#201) ───
//
// `dep<T>()("name")` carries the literal name and the value type in one value,
// so `layer([ConfigTag], ({ config }) => …)` needs no annotation on `acquire`
// and both halves of a dependency mistake land at the `layer` call rather than
// inside `provide`'s `M` constraint. This is Effect's `Context.Tag`.

const ConfigTag = dep<Config>()("config");
const DbTag = dep<string>()("db");

const tokened = provide({
  config: value<Config>({ url: "postgres://x" }),
  db: layer([ConfigTag], ({ config }) => `db@${config.url}`),
  cache: layer([ConfigTag, DbTag], ({ config, db }) => `${db}/${config.url}`),
});

// The `ctx` it produces is keyed and typed exactly as the string form's is.
const tokenedCtx: Promise<{ config: Config; db: string; cache: string }> =
  tokened.open().then((scope) => scope.ctx);
void tokenedCtx;

// The derived parameter carries the token's type rather than `unknown`, and the
// provider's `K` is the token's name — so this annotation fits with no widening.
const derived: Provider<string, { config: Config }, "config"> = layer(
  [ConfigTag],
  ({ config }) => config.url,
);
void derived;

// A token the surrounding map has no key for is a compile error at `provide`,
// exactly as a string dep name is: the token's name is bound to `keyof M` too.
const SecretsTag = dep<string>()("secrets");
provide({
  config: value<Config>({ url: "postgres://x" }),
  // @ts-expect-error `secrets` is a key of no map.
  db: layer([SecretsTag], ({ secrets }) => `db@${secrets}`),
});

// A destructured property the tuple does NOT name fails HERE, at the `layer`
// call — the whole point of the token form, and not deferred to `provide`.
layer(
  [ConfigTag],
  // @ts-expect-error `db` is not a property of the record `[ConfigTag]` derives.
  ({ config, db }) => `${config.url}${db}`,
);

// Reading a named dependency at the wrong type fails at `layer` as well.
layer(
  [ConfigTag],
  // @ts-expect-error `config` is a `Config`, so it has no `port`.
  ({ config }) => config.port,
);

// A token whose name IS a key of the map but whose type is not what the map
// provides still fails at `provide`, the check that predates this overload.
const WrongConfigTag = dep<number>()("config");
provide({
  config: value<Config>({ url: "postgres://x" }),
  // @ts-expect-error the map's `config` is a `Config`, not a `number`.
  db: layer([WrongConfigTag], ({ config }) => `db@${config}`),
});

// An empty token tuple is the zero-dep form, admissible in every map.
provide({ clock: layer([], () => 42) });
