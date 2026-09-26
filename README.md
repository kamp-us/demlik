# demlik

The demlik monorepo. Each package publishes to npm on its own version.

| Package | What it is |
|---|---|
| [`@demlik/tea`](./packages/tea) | A TEA / Elm-Architecture TypeScript library for durable, replayable state machines: one pure reducer, every host adapter. |
| [`@demlik/code-graph`](./packages/code-graph) | An agent-native TypeScript code-graph and smell CLI. It parses a folder with oxc, resolves it with tsgo, measures every function, flags smells, and ranks refactor targets as deterministic JSON. |
| [`@demlik/structure-sweep`](./packages/structure-sweep) | Asks Jev which feature and role every source file belongs to, against a vocabulary the repository supplies, judges code-graph collapse pairs, and moves files into feature folders with their imports rewritten. |
| [`@demlik/backlog-sweep`](./packages/backlog-sweep) | Gathers evidence for every open GitHub issue and asks Jev whether each is still needed, writing one proposal per issue for a human to act on. |

## Working here

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # every package, same as CI
pnpm --filter @demlik/tea <script>         # one package
```

Releases go through [changesets](./.changeset/README.md): `pnpm changeset`, then a version PR.
