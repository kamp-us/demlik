# @demlik/code-graph

Scan TypeScript to find refactor targets, trace calls, and check architecture rules.
The default scan measures functions and reports possible maintenance problems. Optional
reports cover reachability, storage access, duplicate logic, comments, and git hotspots.

## Invocation

Requires Node.js 20 or later. Install it in the project you want to analyze:

```sh
pnpm add -D @demlik/code-graph
pnpm exec code-graph src
pnpm exec code-graph src --plan
```

The path must be a directory. Paths are relative to where you run the command.

Choose the report you need; these examples use `code-graph` as shorthand for
`pnpm exec code-graph`:

| Goal | Command |
|---|---|
| Rank refactor targets | `code-graph src --plan` |
| Browse files and functions | `code-graph src --tree` |
| Inspect one function's callers | `code-graph src --blast example.ts:calculate` |
| Look up a name: where it is declared, whether it is exported, who uses it | `code-graph src --find Order` |
| Save a call graph | `code-graph src --graph --edges --out graph.json` |
| Browse an HTML report | `code-graph src --html --out report.html` |
| Find unreachable functions | `code-graph src --unreachable` |
| Check architecture boundaries | `code-graph . --boundaries` |
| Find churn and complexity hotspots | `code-graph src --hotspots` |

The default scan uses oxc and needs no tsconfig. Call-graph reports use tsgo and require
an accessible `tsconfig.json`. The path controls which files are scanned; `--deep`
changes where the tsconfig is found, without adding files to the scan.

Use `--json` for machine-readable reports and `--out <file>` to save them.
The [CLI reference](docs/reference/cli.md) lists every flag, scope rule, and exit code.

## Documentation

Start with the [documentation index](docs/README.md), or go directly to:

- **How-to:** [Enforce architecture boundaries](docs/how-to/enforce-boundaries.md).
- **Reference:** [CLI](docs/reference/cli.md), [analyses](docs/reference/analyses.md),
  [layers](docs/reference/layers.md), [boundaries](docs/reference/boundaries.md),
  and [library API](docs/reference/library.md).
- **Explanation:** [How analysis works](docs/explanation/how-analysis-works.md), including
  what the reports can and cannot establish.

## Working in this checkout

From the monorepo root:

```sh
pnpm --filter @demlik/code-graph build
node packages/code-graph/dist/index.js packages/code-graph/src --plan
node packages/code-graph/dist/index.js packages/code-graph --graph --edges --out graph.json
node packages/code-graph/dist/index.js packages/code-graph --html --out report.html
```

This repository has package tsconfigs and no root tsconfig. Run call-graph reports on
a package directory. See [scope rules](docs/reference/cli.md#pass-selection-and-scope)
for other repository layouts.

To run the source directly, without building:

```sh
pnpm --filter @demlik/code-graph exec node --import tsx src/index.ts src --plan
```

That command runs inside the package, so its paths are package-relative.

Run the package checks:

```sh
pnpm --filter @demlik/code-graph typecheck
pnpm --filter @demlik/code-graph lint
pnpm --filter @demlik/code-graph test
pnpm --filter @demlik/code-graph build
pnpm --filter @demlik/code-graph verify:exports
```

[Benchmark findings](bench/FINDINGS.md) record the engine measurements and reproduction commands.
