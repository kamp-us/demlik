# @demlik/code-graph

## 0.0.3

### Patch Changes

- `@demlik/code-graph/resolve` resolves. 0.0.2 shipped `exports["./resolve"]` pointing at `./src/resolve.ts`, which is not in the tarball; the export map now points at `dist/` directly instead of relying on a `publishConfig` override only `pnpm pack` applies.
