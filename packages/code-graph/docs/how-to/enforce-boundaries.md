# Adopt a boundary gate

[Documentation index](../README.md) · [Boundary reference](../reference/boundaries.md)

Use this when an existing TypeScript project should block new architecture
crossings while allowing recorded ones to be removed over time.

The package must be installed, and each declared scope must have a tsconfig
at or above it. Run the commands from your workspace root.

## 1. Declare the features

Create `boundary-rules.json`. Replace the example scope and feature names
with your project's directories:

```json
{
  "features": { "packages/app": ["billing", "orders"] },
  "testFiles": ["**/*.test.ts"]
}
```

Declared features use `index.ts`, `ports.ts`, `application/`,
`adapters/driving/`, and `adapters/driven/`. For an existing `rules/` layout,
add `"layout": { "packages/app": "rules" }`.

## 2. Inspect current crossings

```sh
pnpm exec code-graph . --boundaries --boundary-rules boundary-rules.json
```

The report names each rule, importing file, and target. Fix crossings that
should be removed immediately. For the rest, decide what change will remove
them; that becomes the recorded reason.

## 3. Record accepted crossings

```sh
pnpm exec code-graph . --boundaries --boundary-rules boundary-rules.json \
  --accept-crossings --reason "Expose public readers, then remove internal imports."
```

This creates or updates `boundary-ledger.json` with every unrecorded crossing.
The supplied reason applies to all new entries; edit individual reasons
where different fixes are needed. Keep the rules and ledger in version control.

## 4. Add the CI command

```sh
pnpm exec code-graph . --boundaries --boundary-rules boundary-rules.json --ci
```

A new, unrecorded crossing exits 1. Removing a recorded crossing causes the
gate to prune its ledger entry. Commit that updated ledger with the fix.
Invalid declarations exit 2 and need correction before the gate can measure.

## Migrate a legacy count file

If the project still has `boundary-ceilings.json`, use:

```sh
pnpm exec code-graph . --boundaries --boundary-rules boundary-rules.json \
  --migrate-ceilings
```

Migration measures current crossings, creates the ledger, and deletes the
count file. It refuses import counts above their old ceilings. Review the
new ledger before adding the CI command.
