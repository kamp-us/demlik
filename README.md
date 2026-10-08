# demlik

The demlik monorepo. Each package publishes to npm on its own version.

| Package | What it is |
|---|---|
| [`@demlik/tea`](./packages/tea) | A TEA / Elm-Architecture TypeScript library for durable, replayable state machines: one pure reducer, every host adapter. |
| [`@demlik/code-graph`](./packages/code-graph) | Scan TypeScript for refactor targets, call graphs, and architecture violations. |
| [`@demlik/structure-sweep`](./packages/structure-sweep) | Asks Jev which feature and role every source file belongs to, against a vocabulary the repository supplies, judges code-graph collapse pairs, and moves files into feature folders with their imports rewritten. |
| [`@demlik/backlog-sweep`](./packages/backlog-sweep) | Gathers evidence for every open GitHub issue and asks Jev whether each is still needed, writing one proposal per issue for a human to act on. |

## Working here

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # every package, same as CI
pnpm --filter @demlik/tea <script>         # one package
```

Code-graph runs from the repository root through its built CLI:

```sh
pnpm --filter @demlik/code-graph build
node packages/code-graph/dist/index.js packages/code-graph/src --plan
node packages/code-graph/dist/index.js packages/code-graph --graph --edges --out graph.json
```

The default scan needs no tsconfig; call-graph analysis uses the package's tsconfig.
See the [code-graph README](./packages/code-graph/README.md) for common commands and the
[documentation index](./packages/code-graph/docs/README.md) for detailed guides.

Releases go through [changesets](./.changeset/README.md): `pnpm changeset`, then a version PR.
