# demlik

The demlik monorepo. Each package publishes to npm on its own version.

| Package | What it is |
|---|---|
| [`@demlik/tea`](./packages/tea) | A TEA / Elm-Architecture TypeScript library for durable, replayable state machines: one pure reducer, every host adapter. |
| [`@demlik/code-graph`](./packages/code-graph) | An agent-native TypeScript code-graph and smell CLI. It parses a folder with ts-morph, measures every function, flags smells, and ranks refactor targets as deterministic JSON. |

## Working here

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # every package, same as CI
pnpm --filter @demlik/tea <script>         # one package
```

Releases go through [changesets](./.changeset/README.md): `pnpm changeset`, then a version PR.
