---
"@demlik/tea": minor
---

`tool()` on `@demlik/tea/agent` (experimental tier) hands its handler both settle constructors.
The third argument is now `{ ok, fail }` instead of the bare `fail`, so a handler writes
`ok(value)` for the success arm and never imports `better-result` itself — under pnpm's strict
`node_modules` that transitive import did not resolve, and the tutorial's install line had grown a
fourth package (#94).

- `ToolOk<Ok, E>` — `ok(value)`, with `Ok` fixed to what the `ok` schema parses.
- `ToolConstructors<Ok, E>` — the `{ ok, fail }` pair, the handler's third parameter.
- `ToolHandler` is `(args, ctx, { ok, fail }) => Promise<Result<Ok, E>>`. A handler written
  against the positional `fail` reads `fail` as the pair now and does not compile; destructure
  it: `async (args, ctx, { ok, fail }) => …`.
